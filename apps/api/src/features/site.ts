/**
 * Daily site loop: collect what supervisors send, turn it into a log with the
 * site agent, ask a follow-up when something important is missing, then apply
 * the log to the schedule and the stock.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { tracedGenerate } from "../ai/agent-run.js";
import { LlmError, type Part } from "../ai/llm.js";
import {
  checkExtraction,
  contextText,
  extractionSchema,
  SITE_AGENT,
  systemPrompt,
  type CheckedLog,
  type SiteContext,
} from "../agents/site-agent.js";
import { activities, dailyLogs, materials, messages, projectMembers, projects, users } from "../db/schema.js";
import { localDate, localMinutes, parseClock } from "../domain/time.js";
import { EVENTS } from "../events.js";
import { t } from "../i18n.js";
import { enqueue } from "../jobs/queue.js";
import { applyLog, findOrCreateLog, logMessages, type DailyLog } from "../services/daily-logs.js";
import { recalculate } from "../services/schedule.js";
import type { FeatureDeps } from "./types.js";

export const SITE_PROCESS_JOB = "site.process";
export const SITE_CHECKIN_JOB = "site.checkin";

/** Follow-up questions per log before the agent saves what it has. */
export const MAX_FOLLOW_UPS = 2;
/** Media larger than this is skipped (Gemini accepts about 20 MB per request in total). */
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

const REPORTING_ROLES = new Set(["supervisor", "site_engineer"]);

export function registerSiteFeature(deps: FeatureDeps): void {
  const { db, bot, runner, config } = deps;

  deps.scheduler.add("site.check-ins", () => queueDueCheckIns(deps));

  bot?.onMessage(async ({ user, project, message }) => {
    if (!project || !REPORTING_ROLES.has(user.role)) return false;
    if (!["text", "voice", "photo"].includes(message.kind)) return false;
    if (message.kind === "text" && message.text?.startsWith("/")) return false;

    const logDate = localDate(deps.now(), config.SITE_TIME_ZONE);
    const log = await findOrCreateLog(db, { projectId: project.id, supervisorId: user.id, logDate });
    await db.update(messages).set({ dailyLogId: log.id }).where(eq(messages.id, message.id));
    if (log.status === "complete") {
      // Something added after the log was saved: reopen it and process again.
      await db.update(dailyLogs).set({ status: "collecting" }).where(eq(dailyLogs.id, log.id));
    }

    // Supervisors often send a few photos and a voice note in a row. Each
    // message schedules a job a little later, and only the job for the last
    // message does the work.
    await enqueue(
      db,
      SITE_PROCESS_JOB,
      { dailyLogId: log.id, messageId: message.id },
      { runAt: new Date(deps.now().getTime() + config.SITE_BATCH_SECONDS * 1000), idempotencyKey: `site:${message.id}` },
    );
    return true;
  });

  runner.register(SITE_PROCESS_JOB, {
    schema: z.object({ dailyLogId: z.uuid(), messageId: z.uuid() }),
    handle: async ({ dailyLogId, messageId }) => {
      const received = await logMessages(db, dailyLogId);
      if (received.at(-1)?.id !== messageId) return; // a later message will trigger processing
      await processLog(deps, dailyLogId);
    },
  });

  runner.register(SITE_CHECKIN_JOB, {
    schema: z.object({ projectId: z.uuid(), userId: z.uuid(), date: z.iso.date() }),
    handle: async ({ projectId, userId, date }) => {
      if (!bot) return;
      const [log] = await db
        .select()
        .from(dailyLogs)
        .where(and(eq(dailyLogs.projectId, projectId), eq(dailyLogs.supervisorId, userId), eq(dailyLogs.logDate, date)));
      if (log) return; // they already reported today
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
      if (!user?.active || !project?.active) return;
      await bot.sendToUser(user, t("checkIn", user.language, user.name.split(" ")[0]!, project.name), { projectId });
    },
  });
}

async function buildParts(deps: FeatureDeps, received: Awaited<ReturnType<typeof logMessages>>): Promise<Part[]> {
  const parts: Part[] = [];
  let mediaBytes = 0;
  for (const message of received) {
    const time = message.createdAt.toISOString().slice(11, 16);
    if (message.kind === "text") {
      parts.push({ text: `[${time}] Text: ${message.text ?? ""}` });
      continue;
    }
    const label = message.kind === "voice" ? "Voice note" : "Photo";
    if (!message.telegramFileId || !deps.bot) {
      parts.push({ text: `[${time}] ${label} could not be retrieved.` });
      continue;
    }
    try {
      const file = await deps.bot.api.downloadFile(message.telegramFileId);
      if (file.data.length > MAX_MEDIA_BYTES || mediaBytes + file.data.length > 3 * MAX_MEDIA_BYTES) {
        parts.push({ text: `[${time}] ${label} was too large to read.` });
        continue;
      }
      mediaBytes += file.data.length;
      parts.push({ text: `[${time}] ${label}${message.text ? ` with caption: ${message.text}` : ""}:` });
      parts.push({ inlineData: { mimeType: message.mimeType ?? "application/octet-stream", data: file.data.toString("base64") } });
    } catch (error) {
      deps.logger.warn({ err: error, messageId: message.id }, "Could not download Telegram file");
      parts.push({ text: `[${time}] ${label} could not be retrieved.` });
    }
  }
  return parts;
}

async function siteContext(deps: FeatureDeps, log: DailyLog) {
  const [row] = await deps.db
    .select({ project: projects, supervisor: users })
    .from(projects)
    .innerJoin(users, eq(users.id, log.supervisorId))
    .where(eq(projects.id, log.projectId));
  if (!row) throw new Error(`Project for log ${log.id} not found`);

  const open = await deps.db
    .select()
    .from(activities)
    .where(eq(activities.projectId, log.projectId))
    .orderBy(activities.code);
  const tracked = await deps.db.select().from(materials).where(eq(materials.projectId, log.projectId));

  const context: SiteContext = {
    projectName: row.project.name,
    logDate: log.logDate,
    supervisorName: row.supervisor.name,
    language: row.supervisor.language,
    activities: open
      .filter((a) => a.percentComplete < 100 && a.kind !== "milestone")
      .map((a) => ({ code: a.code, name: a.name, zone: a.zone, unit: a.progressUnit, percentComplete: a.percentComplete })),
    materials: tracked.map((m) => ({ name: m.name, unit: m.unit })),
    previous: log.followUpQuestion ? { summary: log.summary, followUpQuestion: log.followUpQuestion } : null,
  };
  return { context, project: row.project, supervisor: row.supervisor };
}

export async function processLog(deps: FeatureDeps, dailyLogId: string): Promise<CheckedLog | null> {
  const { db, llm, bot } = deps;
  const [log] = await db.select().from(dailyLogs).where(eq(dailyLogs.id, dailyLogId));
  if (!log) return null;
  const received = await logMessages(db, dailyLogId);
  if (received.length === 0) return null;

  const { context, project, supervisor } = await siteContext(deps, log);
  const parts: Part[] = [{ text: contextText(context) }, ...(await buildParts(deps, received))];

  let checked: CheckedLog;
  try {
    const result = await tracedGenerate(
      db,
      llm,
      { agent: SITE_AGENT, trigger: `daily_log:${log.id}`, companyId: project.companyId, projectId: project.id },
      { system: systemPrompt(context), parts, schema: extractionSchema },
    );
    checked = checkExtraction(result.value, context);
  } catch (error) {
    // Rate limits and outages are retried by the job queue without bothering the supervisor.
    if (!(error instanceof LlmError) || error.retryable) throw error;
    deps.logger.error({ err: error, dailyLogId }, "Site agent could not process the log");
    if (bot) await bot.sendToUser(supervisor, t("logFailed", supervisor.language), { projectId: project.id, dailyLogId });
    return null;
  }

  if (checked.followUpQuestion && log.followUpsAsked < MAX_FOLLOW_UPS) {
    await db
      .update(dailyLogs)
      .set({
        status: "awaiting_answer",
        summary: checked.summary,
        followUpQuestion: checked.followUpQuestion,
        followUpsAsked: log.followUpsAsked + 1,
        confidence: checked.confidence,
      })
      .where(eq(dailyLogs.id, log.id));
    if (bot) await bot.sendToUser(supervisor, checked.followUpQuestion, { projectId: project.id, dailyLogId });
    return checked;
  }

  await applyLog(db, { log, checked, companyId: project.companyId });
  await recalculate(db, project.id, `Daily log ${log.logDate} from ${supervisor.name}`);
  await deps.events.publish(db, EVENTS.dailyLogCompleted, { dailyLogId: log.id, projectId: project.id }, `${log.id}:${received.at(-1)!.id}`);
  if (bot) await bot.sendToUser(supervisor, t("logSaved", supervisor.language, checked.summary), { projectId: project.id, dailyLogId });
  return checked;
}

/**
 * Queues the evening check-in for every reporting member of every active
 * project whose check-in time has passed today. Safe to call as often as
 * wanted: each person gets at most one check-in per project per day.
 */
export async function queueDueCheckIns(deps: FeatureDeps): Promise<number> {
  const now = deps.now();
  const today = localDate(now, deps.config.SITE_TIME_ZONE);
  const minutes = localMinutes(now, deps.config.SITE_TIME_ZONE);

  const active = await deps.db.select().from(projects).where(eq(projects.active, true));
  const due = active.filter((p) => minutes >= parseClock(p.checkInTime));
  if (due.length === 0) return 0;

  const members = await deps.db
    .select({ projectId: projectMembers.projectId, user: users })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(
      and(
        inArray(
          projectMembers.projectId,
          due.map((p) => p.id),
        ),
        eq(users.active, true),
        inArray(users.role, ["supervisor", "site_engineer"]),
      ),
    );

  let queued = 0;
  for (const { projectId, user } of members) {
    if (!user.telegramChatId) continue;
    const id = await enqueue(
      deps.db,
      SITE_CHECKIN_JOB,
      { projectId, userId: user.id, date: today },
      { idempotencyKey: `checkin:${projectId}:${user.id}:${today}` },
    );
    if (id !== null) queued++;
  }
  return queued;
}

/** Latest logs for the dashboard. */
export async function recentLogs(deps: Pick<FeatureDeps, "db">, projectId: string, limit = 30) {
  return deps.db
    .select()
    .from(dailyLogs)
    .where(eq(dailyLogs.projectId, projectId))
    .orderBy(desc(dailyLogs.logDate))
    .limit(limit);
}
