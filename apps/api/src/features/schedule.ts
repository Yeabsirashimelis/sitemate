/**
 * Schedule agent: reacts to delays reported on site.
 *
 * For each quantified delay it measures the effect on the handover date with
 * time impact analysis, records the delay on the schedule, and when the
 * handover moves it builds the cheapest recovery plan from the measures the
 * project manager has priced, and asks for approval.
 */

import {
  analyzeDelay,
  applyDelay,
  computeSchedule,
  planRecovery,
  type DelayImpact,
  type RecoveryMeasure as EngineMeasure,
} from "@sitemate/engine";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { tracedGenerate } from "../ai/agent-run.js";
import {
  explanationPrompt,
  explanationSchema,
  fallbackExplanation,
  SCHEDULE_AGENT,
  SYSTEM_PROMPT,
  type ExplanationInput,
} from "../agents/schedule-agent.js";
import { audit } from "../audit.js";
import type { Executor } from "../db/client.js";
import { activities, activityLinks, auditLog, dailyLogs, recoveryMeasures } from "../db/schema.js";
import { birr, longDate, plural } from "../domain/format.js";
import { EVENTS } from "../events.js";
import { badRequest, notFound } from "../http/errors.js";
import { loadProjectSchedule, recalculate, type ActivityRow, type ProjectSchedule } from "../services/schedule.js";
import { notifyProject } from "./notify.js";
import type { FeatureDeps } from "./types.js";

export const APPLY_RECOVERY = "schedule.apply_recovery";
export const SET_CONSTRAINT = "schedule.set_constraint";

export type MeasureRow = typeof recoveryMeasures.$inferSelect;

/** Turns stored measures into engine measures, which refer to activities by code. */
export function toEngineMeasures(rows: MeasureRow[], schedule: ProjectSchedule): EngineMeasure[] {
  const codeById = new Map([...schedule.byCode.values()].map((a) => [a.id, a.code]));
  return rows.flatMap((row): EngineMeasure[] => {
    const activityCode = codeById.get(row.activityId);
    if (!activityCode) return [];
    if (row.change.kind === "shorten") {
      return [{ id: row.id, description: row.description, cost: row.cost, risk: row.risk, change: { kind: "shorten", activityId: activityCode, days: row.change.days } }];
    }
    const from = codeById.get(row.change.fromActivityId);
    if (!from) return [];
    return [
      {
        id: row.id,
        description: row.description,
        cost: row.cost,
        risk: row.risk,
        change: { kind: "relink", activityId: activityCode, from, type: row.change.type, lag: row.change.lag },
      },
    ];
  });
}

/** Records extra workdays on an activity: on its remaining work if started, otherwise on its duration. */
async function persistDelay(db: Executor, row: ActivityRow, days: number) {
  if (row.actualStart) {
    await db
      .update(activities)
      .set({ remainingDuration: (row.remainingDuration ?? row.duration) + days })
      .where(eq(activities.id, row.id));
  } else {
    await db.update(activities).set({ duration: row.duration + days }).where(eq(activities.id, row.id));
  }
}

/**
 * Adds a reported delay to the schedule exactly once. The audit entry is the
 * marker, written in the same transaction, so a retried job or a reopened
 * log never counts the same delay twice.
 */
async function recordDelayOnce(
  db: Executor,
  input: { companyId: string; projectId: string; key: string; row: ActivityRow; days: number; reason: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [already] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "schedule.delay_recorded"), eq(auditLog.subjectId, input.key)))
      .limit(1);
    if (already) return false;
    await persistDelay(tx, input.row, input.days);
    await audit(tx, {
      companyId: input.companyId,
      projectId: input.projectId,
      actor: { type: "agent", id: SCHEDULE_AGENT },
      action: "schedule.delay_recorded",
      subject: { type: "delay", id: input.key },
      reason: input.reason,
      data: { activityCode: input.row.code, days: input.days },
    });
    return true;
  });
}

export async function applyRecoveryMeasures(db: Executor, input: { projectId: string; companyId: string; measureIds: string[]; actorId: string }) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(recoveryMeasures)
      .where(
        and(
          eq(recoveryMeasures.projectId, input.projectId),
          inArray(recoveryMeasures.id, input.measureIds),
          isNull(recoveryMeasures.appliedAt),
        ),
      );
    if (rows.length !== new Set(input.measureIds).size) throw new Error("Some recovery measures were already applied or no longer exist");

    for (const measure of rows) {
      const [activity] = await tx.select().from(activities).where(eq(activities.id, measure.activityId));
      if (!activity) throw new Error(`Activity for measure "${measure.description}" no longer exists`);
      if (measure.change.kind === "shorten") {
        if (activity.actualStart) {
          await tx
            .update(activities)
            .set({ remainingDuration: Math.max(1, (activity.remainingDuration ?? activity.duration) - measure.change.days) })
            .where(eq(activities.id, activity.id));
        } else {
          await tx
            .update(activities)
            .set({ duration: Math.max(1, activity.duration - measure.change.days) })
            .where(eq(activities.id, activity.id));
        }
      } else {
        const updated = await tx
          .update(activityLinks)
          .set({ type: measure.change.type, lag: measure.change.lag })
          .where(and(eq(activityLinks.fromActivityId, measure.change.fromActivityId), eq(activityLinks.toActivityId, activity.id)))
          .returning();
        if (updated.length === 0) throw new Error(`The link changed by "${measure.description}" no longer exists`);
      }
      await tx.update(recoveryMeasures).set({ appliedAt: new Date() }).where(eq(recoveryMeasures.id, measure.id));
    }

    const { result } = await recalculate(tx, input.projectId, `Recovery plan applied: ${rows.map((r) => r.description).join("; ")}`);
    await audit(tx, {
      companyId: input.companyId,
      projectId: input.projectId,
      actor: { type: "user", id: input.actorId },
      action: "schedule.recovery_applied",
      data: { measures: rows.map((r) => r.id), finishDate: result.finishDate },
    });
    return { finishDate: result.finishDate };
  });
}

export function registerScheduleFeature(deps: FeatureDeps): void {
  const { approvals, events } = deps;

  approvals.register(
    APPLY_RECOVERY,
    z.object({ projectId: z.uuid(), measureIds: z.array(z.uuid()).min(1) }),
    async (action, context) =>
      applyRecoveryMeasures(context.db, {
        projectId: action.projectId,
        companyId: context.approval.companyId,
        measureIds: action.measureIds,
        actorId: context.decidedBy?.id ?? SCHEDULE_AGENT,
      }),
  );

  approvals.register(
    SET_CONSTRAINT,
    z.object({ projectId: z.uuid(), activityCode: z.string(), notBefore: z.iso.date(), reason: z.string() }),
    async (action, context) => {
      const updated = await context.db
        .update(activities)
        .set({ startNoEarlierThan: action.notBefore })
        .where(and(eq(activities.projectId, action.projectId), eq(activities.code, action.activityCode)))
        .returning();
      if (updated.length === 0) throw new Error(`Activity ${action.activityCode} not found`);
      const { result } = await recalculate(context.db, action.projectId, `${action.activityCode} held until ${action.notBefore}: ${action.reason}`);
      return { finishDate: result.finishDate };
    },
  );

  events.subscribe(EVENTS.dailyLogCompleted, "schedule", z.object({ dailyLogId: z.uuid(), projectId: z.uuid() }), async ({ dailyLogId }) => {
    await handleReportedDelays(deps, dailyLogId);
  });

}

export interface DelayOutcome {
  impacts: Array<{ activityCode: string; days: number; impact: DelayImpact }>;
  slipDays: number;
  proposal: "recovery_plan" | "notification" | "none";
}

export async function handleReportedDelays(deps: FeatureDeps, dailyLogId: string): Promise<DelayOutcome> {
  const { db } = deps;
  const [log] = await db.select().from(dailyLogs).where(eq(dailyLogs.id, dailyLogId));
  if (!log) return { impacts: [], slipDays: 0, proposal: "none" };
  const delays = log.issues.filter(
    (issue): issue is typeof issue & { activityCode: string; delayDays: number } =>
      issue.kind === "delay" && !!issue.activityCode && (issue.delayDays ?? 0) > 0,
  );
  if (delays.length === 0) return { impacts: [], slipDays: 0, proposal: "none" };

  const schedule = await loadProjectSchedule(db, log.projectId);
  const { project, calendar } = schedule;
  const dataDate = project.dataDate;
  const before = computeSchedule(schedule.activities, calendar, { dataDate });

  let current = schedule.activities;
  const impacts: DelayOutcome["impacts"] = [];
  for (const delay of delays) {
    const row = schedule.byCode.get(delay.activityCode);
    if (!row || row.actualFinish) continue;
    const recorded = await recordDelayOnce(db, {
      companyId: project.companyId,
      projectId: project.id,
      key: `${log.id}:${delay.activityCode}`,
      row,
      days: delay.delayDays,
      reason: delay.description,
    });
    // Already counted by an earlier run for this log: it is in the schedule, nothing more to do.
    if (!recorded) continue;
    const impact = analyzeDelay(current, calendar, { activityId: delay.activityCode, days: delay.delayDays, dataDate });
    current = applyDelay(current, { activityId: delay.activityCode, days: delay.delayDays });
    impacts.push({ activityCode: delay.activityCode, days: delay.delayDays, impact });
    await deps.events.publish(
      db,
      EVENTS.delayRecorded,
      {
        projectId: project.id,
        dailyLogId: log.id,
        activityCode: delay.activityCode,
        days: delay.delayDays,
        slipDays: impact.slipDays,
        description: delay.description,
        logDate: log.logDate,
      },
      `${log.id}:${delay.activityCode}`,
    );
  }
  if (impacts.length === 0) return { impacts, slipDays: 0, proposal: "none" };

  const { result: after } = await recalculate(db, project.id, `Delay reported in the daily log of ${log.logDate}`);
  const slipDays = after.projectFinish - before.projectFinish;
  const main = impacts.reduce((a, b) => (b.impact.slipDays > a.impact.slipDays ? b : a));
  const mainRow = schedule.byCode.get(main.activityCode)!;
  const cause = delays.find((d) => d.activityCode === main.activityCode)?.description ?? "reported on site";

  if (slipDays <= 0) {
    await notifyProject(deps, {
      companyId: project.companyId,
      projectId: project.id,
      title: "Delay absorbed by float",
      text: `${main.activityCode} ${mainRow.name} lost ${plural(main.days, "workday")} (${cause}). It had ${plural(main.impact.floatBefore, "day")} of float, so the handover date of ${longDate(after.finishDate)} does not move.`,
      requestedBy: SCHEDULE_AGENT,
    });
    return { impacts, slipDays, proposal: "notification" };
  }

  // Recovery: cheapest set of priced measures that wins the days back.
  const refreshed = await loadProjectSchedule(db, project.id);
  const measureRows = await db
    .select()
    .from(recoveryMeasures)
    .where(and(eq(recoveryMeasures.projectId, project.id), isNull(recoveryMeasures.appliedAt)));
  const { plan } = planRecovery(refreshed.activities, calendar, dataDate, before.projectFinish, toEngineMeasures(measureRows, refreshed));

  const input: ExplanationInput = {
    projectName: project.name,
    activity: { code: main.activityCode, name: mainRow.name },
    cause,
    delayDays: main.days,
    slipDays,
    finishBefore: before.finishDate,
    finishAfter: after.finishDate,
    contractFinish: project.contractFinish,
    criticalPath: after.criticalPath,
    plan: plan.measures.map((m) => ({
      measureId: m.measure.id,
      description: m.measure.description,
      daysRecovered: m.daysRecovered,
      cost: m.measure.cost,
      risk: m.measure.risk,
    })),
    planFinish: plan.finishDate,
    remainingSlip: plan.remainingSlip,
  };

  let explanation = fallbackExplanation(input);
  const notes = new Map<string, string>();
  try {
    const { value } = await tracedGenerate(
      db,
      deps.llm,
      { agent: SCHEDULE_AGENT, trigger: `daily_log:${log.id}`, companyId: project.companyId, projectId: project.id },
      { system: SYSTEM_PROMPT, parts: [{ text: explanationPrompt(input) }], schema: explanationSchema },
    );
    explanation = value.explanation;
    for (const note of value.optionNotes) notes.set(note.measureId, note.note);
  } catch (error) {
    deps.logger.warn({ err: error }, "Schedule agent explanation failed, using the plain summary");
  }

  if (plan.measures.length === 0) {
    await notifyProject(deps, {
      companyId: project.companyId,
      projectId: project.id,
      title: `Handover moves ${plural(slipDays, "workday")}`,
      text: `${explanation}\n\nNo priced recovery measures apply. Add some in the dashboard and SiteMate will work out a plan.`,
      requestedBy: SCHEDULE_AGENT,
    });
    return { impacts, slipDays, proposal: "notification" };
  }

  const lines = plan.measures.map((m) => {
    const note = notes.get(m.measure.id);
    return `- ${m.measure.description}: recovers ${plural(m.daysRecovered, "day")}, ${birr(m.measure.cost)}, ${m.measure.risk} risk${note ? `. ${note}` : ""}`;
  });
  await deps.approvals.propose({
    companyId: project.companyId,
    projectId: project.id,
    kind: "recovery_plan",
    title: `Recovery plan: ${main.activityCode} ${mainRow.name} delay`,
    summary: [
      explanation,
      "",
      ...lines,
      "",
      `Total ${birr(plan.totalCost)}. Recovers ${plan.daysRecovered} of ${plural(slipDays, "day")}, forecast handover ${longDate(plan.finishDate)}.`,
    ].join("\n"),
    action: { type: APPLY_RECOVERY, projectId: project.id, measureIds: plan.measures.map((m) => m.measure.id) },
    evidence: [
      { label: `Daily log ${log.logDate}: ${cause}`, ref: `daily_log:${log.id}` },
      { label: `Critical path: ${after.criticalPath.join(" > ")}` },
    ],
    requestedBy: SCHEDULE_AGENT,
    amountEtb: plan.totalCost,
  });
  return { impacts, slipDays, proposal: "recovery_plan" };
}

/** Runs a delay on a copy of the schedule without saving anything, for the dashboard. */
export async function whatIf(db: Executor, projectId: string, activityCode: string, days: number) {
  const schedule = await loadProjectSchedule(db, projectId);
  const row = schedule.byCode.get(activityCode);
  if (!row) throw notFound("Activity");
  if (row.actualFinish) throw badRequest("That activity is already finished");
  const dataDate = schedule.project.dataDate;
  const impact = analyzeDelay(schedule.activities, schedule.calendar, { activityId: activityCode, days, dataDate });
  const measures = await db
    .select()
    .from(recoveryMeasures)
    .where(and(eq(recoveryMeasures.projectId, projectId), isNull(recoveryMeasures.appliedAt)));
  const recovery = planRecovery(
    applyDelay(schedule.activities, { activityId: activityCode, days }),
    schedule.calendar,
    dataDate,
    impact.before.projectFinish,
    toEngineMeasures(measures, schedule),
  );
  return {
    activityCode,
    days,
    floatBefore: impact.floatBefore,
    slipDays: impact.slipDays,
    finishBefore: impact.before.finishDate,
    finishAfter: impact.after.finishDate,
    newlyCritical: impact.newlyCritical,
    criticalPath: impact.after.criticalPath,
    recovery: {
      options: recovery.options.map((o) => ({
        measureId: o.measure.id,
        description: o.measure.description,
        daysRecovered: o.daysRecovered,
        cost: o.measure.cost,
        costPerDay: o.costPerDay,
        risk: o.measure.risk,
      })),
      plan: {
        measureIds: recovery.plan.measures.map((m) => m.measure.id),
        totalCost: recovery.plan.totalCost,
        daysRecovered: recovery.plan.daysRecovered,
        finishDate: recovery.plan.finishDate,
        remainingSlip: recovery.plan.remainingSlip,
      },
    },
  };
}

