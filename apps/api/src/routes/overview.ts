import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DASHBOARD_ROLES } from "../auth/permissions.js";
import { audit } from "../audit.js";
import { checkExtraction, type Extraction } from "../agents/site-agent.js";
import type { Database } from "../db/client.js";
import { activities, agentRuns, approvals, auditLog, claimEvents, dailyLogs, messages, users, weatherForecasts } from "../db/schema.js";
import { EVENTS } from "../events.js";
import type { FeatureDeps } from "../features/types.js";
import { requireRole } from "../http/auth.js";
import { AppError, notFound } from "../http/errors.js";
import { getAccessibleProject, listAccessibleProjects } from "../services/access.js";
import { earnedValueReport } from "../services/cost.js";
import { applyLog } from "../services/daily-logs.js";
import { forecastMaterials } from "../services/materials.js";
import { latestSnapshot, recalculate } from "../services/schedule.js";

const projectParams = z.object({ projectId: z.uuid() });
const logParams = z.object({ projectId: z.uuid(), logId: z.uuid() });

const logCorrection = z.object({
  summary: z.string().trim().min(2).max(2000),
  workers: z.array(z.object({ trade: z.string().trim().min(1), count: z.number().int().min(0) })),
  progress: z.array(
    z.object({ activityCode: z.string(), percentComplete: z.number().min(0).max(100), quantityDone: z.number().min(0).nullable().default(null), note: z.string().nullable().default(null) }),
  ),
  materialsReceived: z.array(z.object({ material: z.string(), quantity: z.number().min(0), unit: z.string() })),
  materialsUsed: z.array(z.object({ material: z.string(), quantity: z.number().min(0), unit: z.string() })),
  issues: z.array(
    z.object({
      kind: z.enum(["delay", "safety", "quality", "material", "weather", "information", "other"]),
      description: z.string(),
      activityCode: z.string().nullable().default(null),
      severity: z.enum(["low", "medium", "high"]),
      delayDays: z.number().int().min(0).nullable().default(null),
    }),
  ),
});

export function overviewRoutes(app: FastifyInstance, db: Database, deps: FeatureDeps): void {
  /** One card per project for the portfolio screen. */
  app.get("/portfolio", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const visible = await listAccessibleProjects(db, user);
    const ids = visible.map((p) => p.id);
    const pending = ids.length
      ? await db.select({ projectId: approvals.projectId }).from(approvals).where(and(eq(approvals.status, "pending"), inArray(approvals.projectId, ids)))
      : [];
    const openClaims = ids.length
      ? await db.select({ projectId: claimEvents.projectId }).from(claimEvents).where(and(eq(claimEvents.status, "open"), inArray(claimEvents.projectId, ids)))
      : [];

    const cards = [];
    for (const project of visible.filter((p) => p.active)) {
      const snapshot = await latestSnapshot(db, project.id);
      const cost = await earnedValueReport(db, project);
      const materials = await forecastMaterials(db, project.id);
      const [tomorrow] = await db
        .select()
        .from(weatherForecasts)
        .where(and(eq(weatherForecasts.projectId, project.id), gte(weatherForecasts.date, project.dataDate)))
        .orderBy(weatherForecasts.date)
        .limit(1);
      const [lastLog] = await db.select({ logDate: dailyLogs.logDate }).from(dailyLogs).where(eq(dailyLogs.projectId, project.id)).orderBy(desc(dailyLogs.logDate)).limit(1);
      cards.push({
        id: project.id,
        name: project.name,
        locationName: project.locationName,
        dataDate: project.dataDate,
        contractFinish: project.contractFinish,
        forecastFinish: snapshot?.finishDate ?? null,
        slipDays: snapshot?.slipDays ?? null,
        criticalPath: snapshot?.criticalPath ?? [],
        spi: cost.summary.spi,
        cpi: cost.summary.cpi,
        earnedValue: cost.summary.earnedValue,
        budgetAtCompletion: cost.summary.budgetAtCompletion,
        pendingApprovals: pending.filter((a) => a.projectId === project.id).length,
        openClaims: openClaims.filter((c) => c.projectId === project.id).length,
        materialsToOrder: materials.filter((m) => m.status === "order_now" || m.status === "order_soon").length,
        nextForecast: tomorrow ?? null,
        lastLogDate: lastLog?.logDate ?? null,
      });
    }
    return { projects: cards };
  });

  app.get("/projects/:projectId/daily-logs", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const logs = await db
      .select({ log: dailyLogs, supervisorName: users.name })
      .from(dailyLogs)
      .innerJoin(users, eq(users.id, dailyLogs.supervisorId))
      .where(eq(dailyLogs.projectId, projectId))
      .orderBy(desc(dailyLogs.logDate))
      .limit(60);
    const logIds = logs.map((l) => l.log.id);
    const original = logIds.length
      ? await db
          .select({ id: messages.id, dailyLogId: messages.dailyLogId, direction: messages.direction, kind: messages.kind, text: messages.text, createdAt: messages.createdAt })
          .from(messages)
          .where(inArray(messages.dailyLogId, logIds))
          .orderBy(messages.createdAt)
      : [];
    return {
      logs: logs.map((l) => ({
        ...l.log,
        supervisorName: l.supervisorName,
        messages: original.filter((m) => m.dailyLogId === l.log.id),
      })),
    };
  });

  /**
   * A person corrects what the agent understood. The corrected log is applied
   * the same way, so progress, stock and the schedule follow.
   */
  app.put("/projects/:projectId/daily-logs/:logId", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId, logId } = logParams.parse(request.params);
    const project = await getAccessibleProject(db, user, projectId);
    const [log] = await db.select().from(dailyLogs).where(and(eq(dailyLogs.id, logId), eq(dailyLogs.projectId, projectId)));
    if (!log) throw notFound("Daily log");
    const body = logCorrection.parse(request.body);

    const extraction: Extraction = {
      ...body,
      weather: log.weather,
      photoChecks: [],
      missing: [],
      followUpQuestion: null,
      confidence: 1,
    };
    const activityRows = await db
      .select({ code: activities.code, name: activities.name, zone: activities.zone, unit: activities.progressUnit })
      .from(activities)
      .where(eq(activities.projectId, projectId));
    const checked = checkExtraction(extraction, {
      projectName: project.name,
      logDate: log.logDate,
      supervisorName: "",
      language: "en",
      // A correction may lower progress, so the current values are not used as a floor.
      activities: activityRows.map((a) => ({ code: a.code, name: a.name, zone: a.zone, unit: a.unit, percentComplete: 0 })),
      materials: [],
      previous: null,
    });

    await applyLog(db, { log, checked, companyId: user.companyId });
    await db.update(dailyLogs).set({ correctedBy: user.id }).where(eq(dailyLogs.id, logId));
    await audit(db, {
      companyId: user.companyId,
      projectId,
      actor: { type: "user", id: user.id },
      action: "daily_log.corrected",
      subject: { type: "daily_log", id: logId },
    });
    await recalculate(db, projectId, `Daily log ${log.logDate} corrected by ${user.name}`);
    await deps.events.publish(db, EVENTS.dailyLogCompleted, { dailyLogId: logId, projectId }, `${logId}:correction:${Date.now()}`);
    const [fresh] = await db.select().from(dailyLogs).where(eq(dailyLogs.id, logId));
    return { log: fresh };
  });

  /** Streams a photo or voice note sent on Telegram, for people allowed to see the project. */
  app.get("/projects/:projectId/messages/:messageId/media", async (request, reply) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId, messageId } = z.object({ projectId: z.uuid(), messageId: z.uuid() }).parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const [message] = await db.select().from(messages).where(and(eq(messages.id, messageId), eq(messages.projectId, projectId)));
    if (!message?.telegramFileId) throw notFound("Media");
    if (!deps.bot) throw new AppError(503, "unavailable", "Telegram is not configured");
    const file = await deps.bot.api.downloadFile(message.telegramFileId);
    return reply
      .header("content-type", message.mimeType ?? "application/octet-stream")
      .header("cache-control", "private, max-age=3600")
      .send(file.data);
  });

  /** What the agents and people did, newest first, with AI usage. */
  app.get("/projects/:projectId/activity", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const entries = await db.select().from(auditLog).where(eq(auditLog.projectId, projectId)).orderBy(desc(auditLog.createdAt)).limit(150);
    const runs = await db
      .select({
        agent: agentRuns.agent,
        runs: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where ${agentRuns.status} = 'error')::int`,
        inputTokens: sql<number>`coalesce(sum(${agentRuns.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${agentRuns.outputTokens}), 0)::int`,
        avgMs: sql<number>`coalesce(avg(${agentRuns.durationMs}), 0)::int`,
      })
      .from(agentRuns)
      .where(eq(agentRuns.projectId, projectId))
      .groupBy(agentRuns.agent);
    const recentRuns = await db
      .select({ id: agentRuns.id, agent: agentRuns.agent, trigger: agentRuns.trigger, status: agentRuns.status, error: agentRuns.error, durationMs: agentRuns.durationMs, inputTokens: agentRuns.inputTokens, outputTokens: agentRuns.outputTokens, createdAt: agentRuns.createdAt })
      .from(agentRuns)
      .where(eq(agentRuns.projectId, projectId))
      .orderBy(desc(agentRuns.createdAt))
      .limit(50);
    return { entries, agents: runs, recentRuns };
  });
}
