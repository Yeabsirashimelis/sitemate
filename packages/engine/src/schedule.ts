/**
 * Critical path scheduling.
 *
 * Activities form a directed acyclic graph. A forward pass gives the early
 * start and finish of every activity, a backward pass gives the late dates,
 * and the difference is the total float. Activities with no float are on the
 * critical path: if any of them slips, the handover date slips.
 *
 * Time is measured in workday indexes (see calendar.ts). An activity with
 * earlyStart = 3 and duration = 2 occupies workdays 3 and 4, so its
 * earlyFinish is 5 (exclusive end). Dates are only produced at the very end.
 */

import { WorkCalendar, type IsoDate } from "./calendar.js";

export type LinkType = "FS" | "SS" | "FF" | "SF";

export interface Link {
  /** Id of the predecessor activity. */
  from: string;
  /** Finish to start is what most site logic is. Defaults to FS. */
  type?: LinkType;
  /** Workdays of lag (negative = lead). Defaults to 0. */
  lag?: number;
}

export interface Activity {
  id: string;
  name: string;
  /** Planned duration in workdays. 0 = milestone. */
  duration: number;
  predecessors?: readonly Link[];
  /** Progress, filled from the daily logs. */
  actualStart?: IsoDate;
  actualFinish?: IsoDate;
  /** Workdays still needed for an activity in progress, as of the data date. */
  remainingDuration?: number;
}

export type ActivityStatus = "not_started" | "in_progress" | "complete";

export interface ScheduledActivity {
  id: string;
  name: string;
  status: ActivityStatus;
  earlyStart: number;
  earlyFinish: number;
  lateStart: number;
  lateFinish: number;
  /** Workdays this activity can slip before the project finish moves. */
  totalFloat: number;
  /** Workdays this activity can slip before any successor has to move. */
  freeFloat: number;
  critical: boolean;
  startDate: IsoDate;
  finishDate: IsoDate;
}

export interface ScheduleResult {
  activities: Map<string, ScheduledActivity>;
  /** Activities in an order where every predecessor comes first. */
  order: string[];
  /** Exclusive workday index the whole project finishes on. */
  projectFinish: number;
  /** Date of the last working day of the project. */
  finishDate: IsoDate;
  /** Critical activities from start to finish, following the driving links. */
  criticalPath: string[];
}

export interface ScheduleOptions {
  /**
   * Status date of the update. Work not yet done cannot be scheduled before
   * it, and in-progress activities finish `remainingDuration` workdays after it.
   */
  dataDate?: IsoDate;
}

export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly details: { activityIds?: string[] } = {},
  ) {
    super(message);
    this.name = "ScheduleError";
  }
}

interface Edge {
  from: string;
  to: string;
  type: LinkType;
  lag: number;
}

/**
 * The earliest start a link allows for its successor, given the predecessor's
 * early dates and the successor's span.
 */
function earliestStartFromLink(edge: Edge, pred: { es: number; ef: number }, succSpan: number): number {
  switch (edge.type) {
    case "FS":
      return pred.ef + edge.lag;
    case "SS":
      return pred.es + edge.lag;
    case "FF":
      return pred.ef + edge.lag - succSpan;
    case "SF":
      return pred.es + edge.lag - succSpan;
  }
}

/**
 * The latest finish a link allows for its predecessor, given the successor's
 * late dates and the predecessor's span.
 */
function latestFinishFromLink(edge: Edge, succ: { ls: number; lf: number }, predSpan: number): number {
  switch (edge.type) {
    case "FS":
      return succ.ls - edge.lag;
    case "SS":
      return succ.ls - edge.lag + predSpan;
    case "FF":
      return succ.lf - edge.lag;
    case "SF":
      return succ.lf - edge.lag + predSpan;
  }
}

function buildEdges(activities: readonly Activity[]): { edges: Edge[]; byId: Map<string, Activity> } {
  const byId = new Map<string, Activity>();
  for (const activity of activities) {
    if (byId.has(activity.id)) {
      throw new ScheduleError(`Duplicate activity id "${activity.id}"`, { activityIds: [activity.id] });
    }
    if (!Number.isInteger(activity.duration) || activity.duration < 0) {
      throw new ScheduleError(`Activity "${activity.id}" has an invalid duration ${activity.duration}`, {
        activityIds: [activity.id],
      });
    }
    if (activity.actualFinish && !activity.actualStart) {
      throw new ScheduleError(`Activity "${activity.id}" has a finish date but no start date`, {
        activityIds: [activity.id],
      });
    }
    byId.set(activity.id, activity);
  }

  const edges: Edge[] = [];
  for (const activity of activities) {
    for (const link of activity.predecessors ?? []) {
      if (!byId.has(link.from)) {
        throw new ScheduleError(`Activity "${activity.id}" depends on unknown activity "${link.from}"`, {
          activityIds: [activity.id, link.from],
        });
      }
      if (link.from === activity.id) {
        throw new ScheduleError(`Activity "${activity.id}" depends on itself`, { activityIds: [activity.id] });
      }
      edges.push({ from: link.from, to: activity.id, type: link.type ?? "FS", lag: link.lag ?? 0 });
    }
  }
  return { edges, byId };
}

/** Kahn's algorithm. Throws with the activities of one cycle if the logic loops. */
export function topologicalOrder(activities: readonly Activity[]): string[] {
  const { edges } = buildEdges(activities);
  return orderOrThrow(activities, edges);
}

function orderOrThrow(activities: readonly Activity[], edges: readonly Edge[]): string[] {
  const indegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const activity of activities) {
    indegree.set(activity.id, 0);
    successors.set(activity.id, []);
  }
  for (const edge of edges) {
    indegree.set(edge.to, indegree.get(edge.to)! + 1);
    successors.get(edge.from)!.push(edge.to);
  }

  // Keep the input order among ready activities so results are stable.
  const queue = activities.filter((a) => indegree.get(a.id) === 0).map((a) => a.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of successors.get(id)!) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (order.length !== activities.length) {
    const stuck = new Set(activities.map((a) => a.id).filter((id) => !order.includes(id)));
    throw new ScheduleError(`The schedule logic has a loop: ${findCycle(stuck, edges).join(" -> ")}`, {
      activityIds: [...stuck],
    });
  }
  return order;
}

/** Walks predecessor links inside the unresolved set until an activity repeats. */
function findCycle(stuck: ReadonlySet<string>, edges: readonly Edge[]): string[] {
  const predecessorOf = new Map<string, string>();
  for (const edge of edges) {
    if (stuck.has(edge.from) && stuck.has(edge.to) && !predecessorOf.has(edge.to)) {
      predecessorOf.set(edge.to, edge.from);
    }
  }
  const path: string[] = [];
  const seen = new Map<string, number>();
  let current: string | undefined = stuck.values().next().value;
  while (current !== undefined && !seen.has(current)) {
    seen.set(current, path.length);
    path.push(current);
    current = predecessorOf.get(current);
  }
  if (current === undefined) return path.reverse();
  return [...path.slice(seen.get(current)!), current].reverse();
}

export function computeSchedule(
  activities: readonly Activity[],
  calendar: WorkCalendar,
  options: ScheduleOptions = {},
): ScheduleResult {
  if (activities.length === 0) {
    throw new ScheduleError("A schedule needs at least one activity");
  }
  const { edges, byId } = buildEdges(activities);
  const order = orderOrThrow(activities, edges);
  const dataDay = options.dataDate === undefined ? 0 : calendar.indexOf(options.dataDate);

  const incoming = new Map<string, Edge[]>();
  const outgoing = new Map<string, Edge[]>();
  for (const id of order) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const edge of edges) {
    incoming.get(edge.to)!.push(edge);
    outgoing.get(edge.from)!.push(edge);
  }

  // Forward pass.
  const early = new Map<string, { es: number; ef: number; status: ActivityStatus }>();
  for (const id of order) {
    const activity = byId.get(id)!;

    if (activity.actualStart && activity.actualFinish) {
      const es = calendar.indexOf(activity.actualStart);
      const ef = Math.max(es, calendar.indexOf(activity.actualFinish) + 1);
      early.set(id, { es, ef, status: "complete" });
      continue;
    }

    if (activity.actualStart) {
      const es = calendar.indexOf(activity.actualStart);
      const remaining = activity.remainingDuration ?? Math.max(activity.duration - (dataDay - es), 1);
      early.set(id, { es, ef: Math.max(dataDay, es) + remaining, status: "in_progress" });
      continue;
    }

    let es = dataDay;
    for (const edge of incoming.get(id)!) {
      es = Math.max(es, earliestStartFromLink(edge, early.get(edge.from)!, activity.duration));
    }
    early.set(id, { es, ef: es + activity.duration, status: "not_started" });
  }

  let projectFinish = 0;
  for (const { ef } of early.values()) projectFinish = Math.max(projectFinish, ef);

  // Backward pass, measured against the forecast finish so the critical
  // path always has zero float.
  const late = new Map<string, { ls: number; lf: number }>();
  for (const id of [...order].reverse()) {
    const { es, ef } = early.get(id)!;
    const span = ef - es;
    let lf = projectFinish;
    for (const edge of outgoing.get(id)!) {
      lf = Math.min(lf, latestFinishFromLink(edge, late.get(edge.to)!, span));
    }
    late.set(id, { ls: lf - span, lf });
  }

  const result = new Map<string, ScheduledActivity>();
  for (const id of order) {
    const activity = byId.get(id)!;
    const { es, ef, status } = early.get(id)!;
    const { ls, lf } = late.get(id)!;
    const span = ef - es;

    let freeFloat = projectFinish - ef;
    for (const edge of outgoing.get(id)!) {
      const succ = early.get(edge.to)!;
      const allowed = earliestStartFromLink(edge, { es, ef }, succ.ef - succ.es);
      freeFloat = Math.min(freeFloat, succ.es - allowed);
    }

    const totalFloat = lf - ef;
    result.set(id, {
      id,
      name: activity.name,
      status,
      earlyStart: es,
      earlyFinish: ef,
      lateStart: ls,
      lateFinish: lf,
      totalFloat,
      freeFloat: Math.max(0, freeFloat),
      critical: status !== "complete" && totalFloat <= 0,
      startDate: calendar.dateOf(es),
      finishDate: calendar.dateOf(Math.max(es, ef - (span === 0 ? 0 : 1))),
    });
  }

  return {
    activities: result,
    order,
    projectFinish,
    finishDate: calendar.dateOf(Math.max(0, projectFinish - 1)),
    criticalPath: drivingPath(result, incoming, early),
  };
}

/**
 * Follows driving links back from the activity that finishes last. A link is
 * driving when it is what actually sets the successor's early start.
 */
function drivingPath(
  scheduled: Map<string, ScheduledActivity>,
  incoming: Map<string, Edge[]>,
  early: Map<string, { es: number; ef: number; status: ActivityStatus }>,
): string[] {
  let last: ScheduledActivity | undefined;
  for (const activity of scheduled.values()) {
    if (activity.status === "complete") continue;
    if (!last || activity.earlyFinish > last.earlyFinish) last = activity;
  }
  if (!last) return [];

  const path = [last.id];
  let current = last;
  for (;;) {
    const span = current.earlyFinish - current.earlyStart;
    const driver = incoming
      .get(current.id)!
      .find((edge) => {
        const pred = scheduled.get(edge.from)!;
        return (
          pred.status !== "complete" &&
          earliestStartFromLink(edge, early.get(edge.from)!, span) === current.earlyStart
        );
      });
    if (!driver) break;
    current = scheduled.get(driver.from)!;
    path.push(current.id);
  }
  return path.reverse();
}
