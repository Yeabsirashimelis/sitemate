/**
 * Claims file. The claims agent keeps an evidence file for every delay the
 * contractor did not cause, as it happens: the daily log, the photos, the
 * weather, late answers from the consultant, and the effect on the
 * completion date from time impact analysis. When a new event opens, it
 * drafts the notice the contract requires and asks the project manager to
 * send it before the notice period runs out.
 */

import { addCalendarDays } from "@sitemate/engine";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { tracedGenerate } from "../ai/agent-run.js";
import {
  CLAIMS_AGENT,
  CLASSIFY_SYSTEM,
  classificationSchema,
  isClaimable,
  NOTICE_SYSTEM,
  noticeSchema,
  type Classification,
} from "../agents/claims-agent.js";
import { audit } from "../audit.js";
import {
  activities,
  auditLog,
  claimEvents,
  companies,
  dailyLogs,
  messages,
  paymentClaims,
  projects,
  rfis,
  weatherForecasts,
  type ClaimEvidence,
} from "../db/schema.js";
import { birr, longDate, plural } from "../domain/format.js";
import { localDate } from "../domain/time.js";
import { EVENTS } from "../events.js";
import { hasIndexedDocuments, searchDocuments } from "../services/documents.js";
import { projectCalendar, type Project } from "../services/schedule.js";
import { notifyProject } from "./notify.js";
import { whatIf } from "./schedule.js";
import type { FeatureDeps } from "./types.js";

export const SEND_NOTICE = "claims.send_notice";
export const SEND_RFI = "rfi.send";

const delayPayload = z.object({
  projectId: z.uuid(),
  dailyLogId: z.uuid(),
  activityCode: z.string(),
  days: z.number().int(),
  slipDays: z.number().int(),
  description: z.string(),
  logDate: z.iso.date(),
});

export type ClaimEvent = typeof claimEvents.$inferSelect;

export function registerClaimsFeature(deps: FeatureDeps): void {
  const { events, approvals, scheduler, db } = deps;

  events.subscribe(EVENTS.delayRecorded, "claims", delayPayload, async (delay) => {
    await recordDelayForClaims(deps, delay);
  });

  approvals.register(SEND_NOTICE, z.object({ claimEventId: z.uuid() }), async (action, context) => {
    const [event] = await context.db
      .update(claimEvents)
      .set({ status: "notified" })
      .where(and(eq(claimEvents.id, action.claimEventId), eq(claimEvents.status, "open")))
      .returning();
    if (!event) throw new Error("This claim event is no longer open");
    await audit(context.db, {
      companyId: context.approval.companyId,
      projectId: event.projectId,
      actor: { type: "user", id: context.decidedBy?.id ?? CLAIMS_AGENT },
      action: "claims.notice_sent",
      subject: { type: "claim_event", id: event.id },
      reason: event.title,
    });
    return { claimEventId: event.id, status: event.status };
  });

  approvals.register(SEND_RFI, z.object({ rfiId: z.uuid() }), async (action, context) => {
    const [rfi] = await context.db
      .update(rfis)
      .set({ status: "sent" })
      .where(and(eq(rfis.id, action.rfiId), eq(rfis.status, "pending_approval")))
      .returning();
    if (!rfi) throw new Error("This RFI is no longer waiting to be sent");
    return { number: rfi.number, dueOn: rfi.dueOn };
  });

  // Overdue answers from the consultant: remind the project manager once a day.
  scheduler.add("claims.overdue-rfis", async () => {
    const today = localDate(deps.now(), deps.config.SITE_TIME_ZONE);
    const overdue = await db
      .select({ rfi: rfis, project: projects })
      .from(rfis)
      .innerJoin(projects, eq(projects.id, rfis.projectId))
      .where(and(eq(rfis.status, "sent"), lt(rfis.dueOn, today)));
    let reminded = 0;
    for (const { rfi, project } of overdue) {
      const key = `rfi-overdue:${rfi.id}:${today}`;
      const [done] = await db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.action, "rfi.reminded"), eq(auditLog.subjectId, key))).limit(1);
      if (done) continue;
      await audit(db, { companyId: project.companyId, projectId: project.id, actor: { type: "agent", id: CLAIMS_AGENT }, action: "rfi.reminded", subject: { type: "rfi", id: key } });
      const late = projectCalendar(project).workdaysBetween(rfi.dueOn, today);
      await notifyProject(deps, {
        companyId: project.companyId,
        projectId: project.id,
        title: `RFI ${rfi.number} is overdue`,
        text: `RFI ${rfi.number} to ${project.consultant ?? "the consultant"} was due ${longDate(rfi.dueOn)} and is ${plural(late, "workday")} late: "${rfi.question}". The waiting time is being recorded for the claims file.`,
        requestedBy: CLAIMS_AGENT,
      });
      reminded++;
    }
    return reminded;
  });

  // Payment claims certified but not paid within the contract period.
  scheduler.add("claims.late-payments", async () => {
    const today = localDate(deps.now(), deps.config.SITE_TIME_ZONE);
    const cutoff = addCalendarDays(today, -deps.config.PAYMENT_DUE_DAYS);
    const unpaid = await db
      .select({ claim: paymentClaims, project: projects })
      .from(paymentClaims)
      .innerJoin(projects, eq(projects.id, paymentClaims.projectId))
      .where(and(eq(paymentClaims.status, "submitted"), lt(paymentClaims.periodEnd, cutoff)));
    let opened = 0;
    for (const { claim, project } of unpaid) {
      const title = `Late payment of interim payment claim ${claim.number}`;
      const [exists] = await db
        .select({ id: claimEvents.id })
        .from(claimEvents)
        .where(and(eq(claimEvents.projectId, project.id), eq(claimEvents.title, title)));
      if (exists) continue;
      await openClaimEvent(deps, project, {
        classification: { cause: "late_payment", responsible: "client", title, reasoning: "The client has not paid a submitted claim within the payment period." },
        description: `Interim payment claim ${claim.number} for work up to ${longDate(claim.periodEnd)}, ${birr(claim.netThisPeriod)} net, has not been paid within ${deps.config.PAYMENT_DUE_DAYS} days.`,
        startedOn: addCalendarDays(claim.periodEnd, deps.config.PAYMENT_DUE_DAYS),
        activityIds: [],
        delayDays: 0,
        evidence: [{ type: "payment", ref: `payment_claim:${claim.id}`, date: claim.periodEnd, note: `Claim ${claim.number} submitted, ${birr(claim.netThisPeriod)} net` }],
      });
      opened++;
    }
    return opened;
  });
}

/** Called for each delay the schedule agent records. Opens a claim event when the contractor did not cause it. */
export async function recordDelayForClaims(deps: FeatureDeps, delay: z.infer<typeof delayPayload>): Promise<ClaimEvent | null> {
  const { db } = deps;
  const [project] = await db.select().from(projects).where(eq(projects.id, delay.projectId));
  const [log] = await db.select().from(dailyLogs).where(eq(dailyLogs.id, delay.dailyLogId));
  if (!project || !log) return null;

  // A retried job must not open the same event twice.
  const ref = `delay:${delay.dailyLogId}:${delay.activityCode}`;
  const [already] = await db
    .select()
    .from(claimEvents)
    .where(and(eq(claimEvents.projectId, project.id), sql`${claimEvents.evidence} @> ${JSON.stringify([{ ref }])}::jsonb`))
    .limit(1);
  if (already) return already;

  const [activity] = await db
    .select()
    .from(activities)
    .where(and(eq(activities.projectId, project.id), eq(activities.code, delay.activityCode)));
  const openRfis = await db
    .select()
    .from(rfis)
    .where(and(eq(rfis.projectId, project.id), inArray(rfis.status, ["sent", "answered"])));
  const related = openRfis.filter((r) => r.activityId === activity?.id);

  const facts = [
    `Project: ${project.name}. Client: ${project.client ?? "not recorded"}. Consultant: ${project.consultant ?? "not recorded"}.`,
    `Delay on ${delay.activityCode} ${activity?.name ?? ""}: ${delay.days} workdays, reported ${delay.logDate}: "${delay.description}".`,
    `Supervisor's report that day: ${log.summary ?? ""}`,
    ...related.map((r) => `RFI ${r.number} on this activity: "${r.question}", due ${r.dueOn}${r.answeredOn ? `, answered ${r.answeredOn}` : ", not answered"}.`),
  ].join("\n");

  const { value: classification } = await tracedGenerate(
    db,
    deps.llm,
    { agent: CLAIMS_AGENT, trigger: `delay:${delay.dailyLogId}:${delay.activityCode}`, companyId: project.companyId, projectId: project.id },
    { system: CLASSIFY_SYSTEM, parts: [{ text: facts }], schema: classificationSchema },
  );
  if (!isClaimable(classification)) return null;

  const evidence: ClaimEvidence[] = [
    { type: "daily_log", ref: `daily_log:${log.id}`, date: log.logDate, note: delay.description },
    {
      type: "schedule",
      ref,
      date: log.logDate,
      note: `Time impact analysis: ${plural(delay.slipDays, "workday")} added to the forecast completion`,
    },
  ];
  const photos = await db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.dailyLogId, log.id), eq(messages.kind, "photo")));
  for (const photo of photos) evidence.push({ type: "photo", ref: `message:${photo.id}`, date: log.logDate, note: "Site photo sent with the daily report" });
  for (const rfi of related) evidence.push({ type: "rfi", ref: `rfi:${rfi.id}`, date: rfi.raisedOn, note: `RFI ${rfi.number} due ${rfi.dueOn}` });
  if (classification.cause === "weather") {
    const [weather] = await db
      .select()
      .from(weatherForecasts)
      .where(and(eq(weatherForecasts.projectId, project.id), eq(weatherForecasts.date, log.logDate)));
    if (weather) evidence.push({ type: "weather", ref: `weather:${log.logDate}`, date: log.logDate, note: `${weather.precipitationMm} mm of rain recorded by Open-Meteo` });
  }

  return openClaimEvent(deps, project, {
    classification,
    description: delay.description,
    startedOn: delay.logDate,
    activityIds: activity ? [activity.id] : [],
    delayDays: delay.slipDays,
    evidence,
  });
}

export async function openClaimEvent(
  deps: FeatureDeps,
  project: Project,
  input: {
    classification: Classification;
    description: string;
    startedOn: string;
    activityIds: string[];
    delayDays: number;
    evidence: ClaimEvidence[];
  },
): Promise<ClaimEvent> {
  const { db } = deps;

  // Contract clauses this event relies on, if the contract has been uploaded.
  let clauseRefs: string[] = [];
  let clauseText = "";
  if (await hasIndexedDocuments(db, project.id, ["contract"])) {
    const hits = await searchDocuments(db, deps.llm, {
      projectId: project.id,
      question: `extension of time notice claim ${input.classification.cause.replace("_", " ")} ${input.description}`,
      limit: 3,
      kinds: ["contract"],
    });
    clauseRefs = [...new Set(hits.filter((h) => h.clause).map((h) => h.clause!))];
    clauseText = hits.map((h) => `Clause ${h.clause ?? "?"} ${h.heading ?? ""}: ${h.content}`).join("\n\n");
  }

  const [event] = await db
    .insert(claimEvents)
    .values({
      projectId: project.id,
      cause: input.classification.cause,
      responsible: input.classification.responsible,
      title: input.classification.title,
      description: input.description,
      startedOn: input.startedOn,
      activityIds: input.activityIds,
      delayDays: input.delayDays,
      evidence: input.evidence,
      clauseRefs,
    })
    .returning();

  const noticeDeadline = addCalendarDays(input.startedOn, deps.config.CLAIM_NOTICE_DAYS);
  const [company] = await db.select().from(companies).where(eq(companies.id, project.companyId));
  let notice: { subject: string; body: string };
  try {
    const { value } = await tracedGenerate(
      db,
      deps.llm,
      { agent: CLAIMS_AGENT, trigger: `notice:${event!.id}`, companyId: project.companyId, projectId: project.id },
      {
        system: NOTICE_SYSTEM,
        parts: [
          {
            text: [
              `Contractor: ${company?.name}. Project: ${project.name}. Engineer: ${project.consultant ?? "the Engineer"}. Employer: ${project.client ?? "the Employer"}.`,
              `Event: ${input.classification.title}. ${input.description}`,
              `Started: ${input.startedOn}. Cause: ${input.classification.cause}. Responsible: ${input.classification.responsible}.`,
              `Effect on completion from the contractor's time impact analysis: ${plural(input.delayDays, "workday")}.`,
              `Evidence held: ${input.evidence.map((e) => `${e.type} ${e.date}: ${e.note}`).join("; ")}`,
              clauseText ? `Contract clauses:\n${clauseText}` : "The contract has not been uploaded; refer to the relevant clauses of the Contract in general terms.",
            ].join("\n"),
          },
        ],
        schema: noticeSchema,
      },
    );
    notice = value;
  } catch (error) {
    deps.logger.warn({ err: error }, "Notice drafting failed, using a plain notice");
    notice = {
      subject: `Notice of delay: ${input.classification.title}`,
      body: `We give notice that ${input.description.charAt(0).toLowerCase()}${input.description.slice(1)}, starting on ${longDate(input.startedOn)}. Our schedule analysis shows a delay of ${plural(input.delayDays, "workday")} to the Time for Completion. We intend to claim an extension of time${clauseRefs.length ? ` under clause ${clauseRefs.join(", ")}` : " under the Contract"} and are keeping contemporary records. Further particulars will follow.`,
    };
  }
  const letter = `Subject: ${notice.subject}\n\n${notice.body}`;
  await db.update(claimEvents).set({ noticeDraft: letter }).where(eq(claimEvents.id, event!.id));

  await deps.approvals.propose({
    companyId: project.companyId,
    projectId: project.id,
    kind: "delay_notice",
    title: `Send delay notice: ${input.classification.title}`,
    summary: `${input.classification.reasoning} Effect on completion: ${plural(input.delayDays, "workday")}. The contract notice period ends ${longDate(noticeDeadline)}${clauseRefs.length ? ` (clause ${clauseRefs.join(", ")})` : ""}.\n\n${letter}`,
    action: { type: SEND_NOTICE, claimEventId: event!.id },
    evidence: input.evidence.map((e) => ({ label: `${e.type.replace("_", " ")} ${e.date}: ${e.note}`, ref: e.ref })),
    requestedBy: CLAIMS_AGENT,
    expiresInHours: deps.config.CLAIM_NOTICE_DAYS * 24,
  });
  return { ...event!, noticeDraft: letter };
}

/** Answering an RFI late is itself a delay caused by the consultant. */
export async function recordRfiAnswer(deps: FeatureDeps, input: { rfiId: string; answer: string; answeredOn: string; actorId: string; companyId: string }) {
  const { db } = deps;
  const [rfi] = await db
    .update(rfis)
    .set({ status: "answered", answer: input.answer, answeredOn: input.answeredOn })
    .where(and(eq(rfis.id, input.rfiId), inArray(rfis.status, ["sent", "pending_approval", "draft"])))
    .returning();
  if (!rfi) throw new Error("RFI not found or already answered");
  const [project] = await db.select().from(projects).where(eq(projects.id, rfi.projectId));
  await audit(db, {
    companyId: input.companyId,
    projectId: rfi.projectId,
    actor: { type: "user", id: input.actorId },
    action: "rfi.answered",
    subject: { type: "rfi", id: rfi.id },
  });
  if (!project || input.answeredOn <= rfi.dueOn) return { rfi, claimEvent: null };

  const lateDays = projectCalendar(project).workdaysBetween(rfi.dueOn, input.answeredOn);
  // The effect on completion depends on the activity's float, so measure it.
  let effect = lateDays;
  if (rfi.activityId) {
    const [activity] = await db.select().from(activities).where(eq(activities.id, rfi.activityId));
    if (activity && !activity.actualFinish && lateDays > 0) {
      try {
        effect = (await whatIf(db, project.id, activity.code, lateDays)).slipDays;
      } catch (error) {
        deps.logger.warn({ err: error }, "Could not measure the effect of a late RFI, using the days late");
      }
    }
  }
  const claimEvent = await openClaimEvent(deps, project, {
    classification: {
      cause: "late_information",
      responsible: "consultant",
      title: `Late answer to RFI ${rfi.number}`,
      reasoning: `The consultant answered RFI ${rfi.number} ${plural(lateDays, "workday")} after it was due.`,
    },
    description: `RFI ${rfi.number} ("${rfi.question}") was due on ${longDate(rfi.dueOn)} and answered on ${longDate(input.answeredOn)}, ${plural(lateDays, "workday")} late`,
    startedOn: rfi.dueOn,
    activityIds: rfi.activityId ? [rfi.activityId] : [],
    delayDays: effect,
    evidence: [{ type: "rfi", ref: `rfi:${rfi.id}`, date: input.answeredOn, note: `Due ${rfi.dueOn}, answered ${input.answeredOn}` }],
  });
  return { rfi, claimEvent };
}
