/**
 * Requests for information to the consultant.
 *
 * When a supervisor reports that work is waiting on a drawing, a detail or a
 * decision, an RFI is drafted against that activity and put to the project
 * manager. Once approved it goes to the consultant on Telegram, and their
 * reply there is recorded as the answer. Until then the activity shows as
 * blocked in the look-ahead, and a late answer feeds the claims file.
 */

import { addCalendarDays } from "@sitemate/engine";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import { z } from "zod";
import { CLAIMS_AGENT } from "../agents/claims-agent.js";
import type { User } from "../auth/sessions.js";
import { activities, companies, dailyLogs, projectMembers, projects, rfis, users } from "../db/schema.js";
import { longDate } from "../domain/format.js";
import { localDate } from "../domain/time.js";
import { EVENTS } from "../events.js";
import { t } from "../i18n.js";
import type { Project } from "../services/schedule.js";
import { recordRfiAnswer } from "./claims.js";
import type { FeatureDeps } from "./types.js";

export const SEND_RFI = "rfi.send";
/** Days the consultant is given to answer an RFI drafted from site. */
export const RFI_ANSWER_DAYS = 5;

export type Rfi = typeof rfis.$inferSelect;
const OPEN = ["draft", "pending_approval", "sent"] as const;

export function registerRfiFeature(deps: FeatureDeps): void {
  const { approvals, events, bot } = deps;

  approvals.register(SEND_RFI, z.object({ rfiId: z.uuid() }), async (action, context) => {
    const [rfi] = await context.db
      .update(rfis)
      .set({ status: "sent" })
      .where(and(eq(rfis.id, action.rfiId), eq(rfis.status, "pending_approval")))
      .returning();
    if (!rfi) throw new Error("This RFI is no longer waiting to be sent");
    const deliveredTo = await deliverRfi(deps, rfi);
    return { number: rfi.number, dueOn: rfi.dueOn, deliveredTo };
  });

  // Supervisors say what they are waiting for; the RFI is drafted from that.
  events.subscribe(EVENTS.dailyLogCompleted, "rfis", z.object({ dailyLogId: z.uuid(), projectId: z.uuid() }), async ({ dailyLogId }) => {
    await draftRfisFromLog(deps, dailyLogId);
  });

  bot?.onMessage(async ({ user, message }) => {
    if (user.role !== "consultant" || message.kind !== "text" || !message.text || message.text.startsWith("/")) return false;
    await handleConsultantReply(deps, user, message.text);
    return true;
  });
}

/** Creates the RFI and asks the project manager to approve sending it. */
export async function raiseRfi(
  deps: FeatureDeps,
  input: { project: Project; question: string; activityId: string | null; dueInDays: number; requestedBy: string; evidence?: string },
): Promise<Rfi> {
  const { db } = deps;
  const { project } = input;
  const rfi = await db.transaction(async (tx) => {
    const [{ last }] = (await tx.select({ last: max(rfis.number) }).from(rfis).where(eq(rfis.projectId, project.id))) as [{ last: number | null }];
    const raisedOn = project.dataDate;
    const [created] = await tx
      .insert(rfis)
      .values({
        projectId: project.id,
        number: (last ?? 0) + 1,
        question: input.question,
        activityId: input.activityId,
        status: "pending_approval",
        raisedOn,
        dueOn: addCalendarDays(raisedOn, input.dueInDays),
      })
      .returning();
    return created!;
  });

  const activity = input.activityId ? (await db.select().from(activities).where(eq(activities.id, input.activityId)))[0] : undefined;
  await deps.approvals.propose({
    companyId: project.companyId,
    projectId: project.id,
    kind: "consultant_rfi",
    title: `Send RFI ${rfi.number} to ${project.consultant ?? "the consultant"}`,
    summary: `${rfi.question}\n\nAnswer requested by ${longDate(rfi.dueOn)}.${activity ? ` Needed for ${activity.code} ${activity.name}, which is held until the answer comes.` : ""}`,
    action: { type: SEND_RFI, rfiId: rfi.id },
    evidence: input.evidence ? [{ label: input.evidence }] : [],
    requestedBy: input.requestedBy,
  });
  return rfi;
}

/** Drafts one RFI per "waiting for information" issue in a finished daily log, unless one is already open for it. */
export async function draftRfisFromLog(deps: FeatureDeps, dailyLogId: string): Promise<number> {
  const { db } = deps;
  const [row] = await db
    .select({ log: dailyLogs, project: projects })
    .from(dailyLogs)
    .innerJoin(projects, eq(projects.id, dailyLogs.projectId))
    .where(eq(dailyLogs.id, dailyLogId));
  if (!row) return 0;
  const { log, project } = row;
  const open = await db
    .select()
    .from(rfis)
    .where(and(eq(rfis.projectId, project.id), inArray(rfis.status, [...OPEN])));

  let drafted = 0;
  for (const issue of log.issues.filter((i) => i.kind === "information")) {
    const [activity] = issue.activityCode
      ? await db
          .select()
          .from(activities)
          .where(and(eq(activities.projectId, project.id), eq(activities.code, issue.activityCode)))
      : [];
    const activityId = activity?.id ?? null;
    // One open question per activity is enough; the supervisor will mention it every day until it is answered.
    if (open.some((r) => (activityId ? r.activityId === activityId : r.question === issue.description))) continue;
    const created = await raiseRfi(deps, {
      project,
      question: `${issue.description.replace(/\.?\s*$/, ".")} Please provide what is needed so the work can go ahead.`,
      activityId,
      dueInDays: RFI_ANSWER_DAYS,
      requestedBy: CLAIMS_AGENT,
      evidence: `Reported from site in the daily log of ${longDate(log.logDate)}`,
    });
    open.push(created);
    drafted++;
  }
  return drafted;
}

/** The RFI as a short formal letter, for Telegram or to paste into an email. */
export function rfiLetter(input: { rfi: Pick<Rfi, "number" | "question" | "raisedOn" | "dueOn">; project: Pick<Project, "name" | "consultant">; company: string; activity?: { code: string; name: string } | null }): string {
  const { rfi, project, company, activity } = input;
  return [
    `Request for information ${rfi.number}, ${project.name}`,
    "",
    `To: ${project.consultant ?? "The consultant"}`,
    `From: ${company}`,
    `Date: ${longDate(rfi.raisedOn)}`,
    ...(activity ? [`Work affected: ${activity.code} ${activity.name}`] : []),
    "",
    rfi.question,
    "",
    `Please answer by ${longDate(rfi.dueOn)}. The work above is held until the answer is received.`,
  ].join("\n");
}

/**
 * Sends an approved RFI to the consultants on the project, or to every
 * consultant of the company when none is on the project. Returns how many
 * received it; the dashboard also offers the letter to send by email.
 */
export async function deliverRfi(deps: FeatureDeps, rfi: Rfi): Promise<number> {
  const { db, bot } = deps;
  if (!bot) return 0;
  const [project] = await db.select().from(projects).where(eq(projects.id, rfi.projectId));
  if (!project) return 0;
  const [company] = await db.select().from(companies).where(eq(companies.id, project.companyId));
  const consultants = await db
    .select()
    .from(users)
    .where(and(eq(users.companyId, project.companyId), eq(users.role, "consultant"), eq(users.active, true)));
  const members = new Set(
    (await db.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id))).map((m) => m.userId),
  );
  const onProject = consultants.filter((c) => members.has(c.id));
  const activity = rfi.activityId ? (await db.select().from(activities).where(eq(activities.id, rfi.activityId)))[0] : undefined;

  const letter = rfiLetter({ rfi, project, company: company?.name ?? "The contractor", activity: activity ?? null });
  const text = `${letter}\n\nReply here with your answer, starting with "RFI ${rfi.number}".`;
  let delivered = 0;
  for (const consultant of onProject.length ? onProject : consultants) {
    if (await bot.sendToUser(consultant, text, { projectId: project.id })) delivered++;
  }
  return delivered;
}

/** A consultant's Telegram reply becomes the answer to the RFI it names, or the only one open. */
export async function handleConsultantReply(deps: FeatureDeps, user: User, text: string): Promise<"answered" | "which" | "none"> {
  const { db, bot } = deps;
  const open = await db
    .select({ rfi: rfis, project: projects })
    .from(rfis)
    .innerJoin(projects, eq(projects.id, rfis.projectId))
    .where(and(eq(projects.companyId, user.companyId), eq(rfis.status, "sent")))
    .orderBy(desc(rfis.raisedOn));
  if (open.length === 0) {
    await bot?.sendToUser(user, t("rfiNoneOpen", user.language));
    return "none";
  }

  const named = /\bRFI\s*#?\s*(\d+)\b/i.exec(text);
  const target = named ? open.find((o) => o.rfi.number === Number(named[1])) : open.length === 1 ? open[0] : undefined;
  if (!target) {
    const list = open.map((o) => `RFI ${o.rfi.number} (${o.project.name}): ${o.rfi.question}`).join("\n");
    await bot?.sendToUser(user, t("rfiWhich", user.language, list));
    return "which";
  }

  const answer = text.replace(/^\s*RFI\s*#?\s*\d+\s*[:.,-]?\s*/i, "").trim() || text;
  await recordRfiAnswer(deps, {
    rfiId: target.rfi.id,
    answer,
    answeredOn: localDate(deps.now(), deps.config.SITE_TIME_ZONE),
    actorId: user.id,
    companyId: user.companyId,
  });
  await bot?.sendToUser(user, t("rfiAnswered", user.language, target.rfi.number), { projectId: target.project.id });
  return "answered";
}
