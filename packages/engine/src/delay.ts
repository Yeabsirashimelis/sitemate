/**
 * Delay impact and recovery.
 *
 * Delay impact follows time impact analysis: the delay is added to a copy of
 * the schedule as it stood on the day it happened, and the change in the
 * forecast finish is the impact. Nothing here guesses; every number comes
 * from re-running the scheduling engine.
 */

import type { IsoDate, WorkCalendar } from "./calendar.js";
import { computeSchedule, type Activity, type LinkType, type ScheduleResult } from "./schedule.js";

export interface DelayEvent {
  activityId: string;
  /** Extra workdays the activity now needs. */
  days: number;
  /** Status date the delay is measured from. */
  dataDate: IsoDate;
}

export interface DelayImpact {
  before: ScheduleResult;
  after: ScheduleResult;
  /** Workdays the project finish moved. 0 when the delay was absorbed by float. */
  slipDays: number;
  /** Float the delayed activity had before the delay. */
  floatBefore: number;
  /** Activities that became critical because of the delay. */
  newlyCritical: string[];
}

/** Returns a copy of the activities with the delay applied. */
export function applyDelay(activities: readonly Activity[], delay: Omit<DelayEvent, "dataDate">): Activity[] {
  if (!Number.isInteger(delay.days) || delay.days <= 0) {
    throw new Error(`Delay must be a positive whole number of workdays, got ${delay.days}`);
  }
  let found = false;
  const updated = activities.map((activity) => {
    if (activity.id !== delay.activityId) return activity;
    found = true;
    if (activity.actualFinish) {
      throw new Error(`Activity "${activity.id}" is already complete and cannot be delayed`);
    }
    if (activity.actualStart) {
      const remaining = activity.remainingDuration ?? activity.duration;
      return { ...activity, remainingDuration: remaining + delay.days };
    }
    return { ...activity, duration: activity.duration + delay.days };
  });
  if (!found) throw new Error(`Unknown activity "${delay.activityId}"`);
  return updated;
}

export function analyzeDelay(
  activities: readonly Activity[],
  calendar: WorkCalendar,
  delay: DelayEvent,
): DelayImpact {
  const options = { dataDate: delay.dataDate };
  const before = computeSchedule(activities, calendar, options);
  const after = computeSchedule(applyDelay(activities, delay), calendar, options);

  const newlyCritical = [...after.activities.values()]
    .filter((a) => a.critical && !before.activities.get(a.id)!.critical)
    .map((a) => a.id);

  return {
    before,
    after,
    slipDays: after.projectFinish - before.projectFinish,
    floatBefore: before.activities.get(delay.activityId)!.totalFloat,
    newlyCritical,
  };
}

export type RecoveryChange =
  /** Do the activity faster: more crew, overtime, a second shift. */
  | { kind: "shorten"; activityId: string; days: number }
  /** Overlap work that was planned in sequence, e.g. start blockwork before the slab above cures. */
  | { kind: "relink"; activityId: string; from: string; type: LinkType; lag: number };

export interface RecoveryMeasure {
  id: string;
  description: string;
  change: RecoveryChange;
  /** Extra cost in birr. */
  cost: number;
  risk: "low" | "medium" | "high";
}

export interface EvaluatedMeasure {
  measure: RecoveryMeasure;
  /** Workdays of the slip this measure wins back on its own. */
  daysRecovered: number;
  costPerDay: number;
}

export interface RecoveryPlan {
  measures: EvaluatedMeasure[];
  totalCost: number;
  daysRecovered: number;
  /** Forecast finish with every measure in the plan applied. */
  finishDate: IsoDate;
  /** Slip left after the plan. 0 means the original date is held. */
  remainingSlip: number;
}

export function applyMeasure(activities: readonly Activity[], change: RecoveryChange): Activity[] {
  let found = false;
  const updated = activities.map((activity) => {
    if (activity.id !== change.activityId) return activity;
    found = true;

    if (change.kind === "shorten") {
      if (activity.actualStart) {
        const remaining = activity.remainingDuration ?? activity.duration;
        return { ...activity, remainingDuration: Math.max(1, remaining - change.days) };
      }
      return { ...activity, duration: Math.max(1, activity.duration - change.days) };
    }

    const predecessors = activity.predecessors ?? [];
    if (!predecessors.some((link) => link.from === change.from)) {
      throw new Error(`Activity "${activity.id}" has no link from "${change.from}" to change`);
    }
    return {
      ...activity,
      predecessors: predecessors.map((link) =>
        link.from === change.from ? { from: link.from, type: change.type, lag: change.lag } : link,
      ),
    };
  });
  if (!found) throw new Error(`Unknown activity "${change.activityId}"`);
  return updated;
}

/**
 * Prices every candidate measure against the delayed schedule, then builds a
 * plan by repeatedly taking the cheapest measure per day recovered until the
 * slip is gone or nothing helps any more. Re-evaluating after each pick
 * matters: once one chain is shortened, a different chain is often critical.
 */
export function planRecovery(
  delayedActivities: readonly Activity[],
  calendar: WorkCalendar,
  dataDate: IsoDate,
  targetFinish: number,
  candidates: readonly RecoveryMeasure[],
): { options: EvaluatedMeasure[]; plan: RecoveryPlan } {
  const options = { dataDate };
  const baseFinish = computeSchedule(delayedActivities, calendar, options).projectFinish;

  const evaluate = (activities: readonly Activity[], measure: RecoveryMeasure, finish: number) => {
    const next = applyMeasure(activities, measure.change);
    const daysRecovered = finish - computeSchedule(next, calendar, options).projectFinish;
    return { next, daysRecovered };
  };

  const ranked = (list: EvaluatedMeasure[]) =>
    list
      .filter((m) => m.daysRecovered > 0)
      .sort((a, b) => a.costPerDay - b.costPerDay || b.daysRecovered - a.daysRecovered);

  const standalone = ranked(
    candidates.map((measure) => {
      const { daysRecovered } = evaluate(delayedActivities, measure, baseFinish);
      return { measure, daysRecovered, costPerDay: daysRecovered > 0 ? measure.cost / daysRecovered : Infinity };
    }),
  );

  let current = [...delayedActivities];
  let finish = baseFinish;
  const chosen: EvaluatedMeasure[] = [];
  const remaining = new Set(candidates);

  while (finish > targetFinish && remaining.size > 0) {
    let best: (EvaluatedMeasure & { next: Activity[] }) | undefined;
    for (const measure of remaining) {
      const { next, daysRecovered } = evaluate(current, measure, finish);
      if (daysRecovered <= 0) continue;
      const costPerDay = measure.cost / daysRecovered;
      if (!best || costPerDay < best.costPerDay) best = { measure, daysRecovered, costPerDay, next };
    }
    if (!best) break;
    chosen.push({ measure: best.measure, daysRecovered: best.daysRecovered, costPerDay: best.costPerDay });
    remaining.delete(best.measure);
    current = best.next;
    finish -= best.daysRecovered;
  }

  return {
    options: standalone,
    plan: {
      measures: chosen,
      totalCost: chosen.reduce((sum, m) => sum + m.measure.cost, 0),
      daysRecovered: baseFinish - finish,
      finishDate: calendar.dateOf(Math.max(0, finish - 1)),
      remainingSlip: Math.max(0, finish - targetFinish),
    },
  };
}
