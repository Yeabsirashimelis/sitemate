import {
  computeSchedule,
  ScheduleError,
  WorkCalendar,
  type Activity as EngineActivity,
  type ScheduleResult,
} from "@sitemate/engine";
import { asc, desc, eq } from "drizzle-orm";
import { audit } from "../audit.js";
import type { Executor } from "../db/client.js";
import { activities, activityLinks, projects, scheduleSnapshots } from "../db/schema.js";
import { ImportError, validateImport, type ImportedActivity } from "../domain/schedule-import.js";
import { badRequest, conflict, notFound } from "../http/errors.js";

export type Project = typeof projects.$inferSelect;
export type ActivityRow = typeof activities.$inferSelect;

export interface ProjectSchedule {
  project: Project;
  calendar: WorkCalendar;
  /** Engine activities, identified by activity code. */
  activities: EngineActivity[];
  byCode: Map<string, ActivityRow>;
}

export function projectCalendar(project: Pick<Project, "startDate" | "calendar">): WorkCalendar {
  return new WorkCalendar(project.startDate, project.calendar);
}

export async function loadProjectSchedule(db: Executor, projectId: string): Promise<ProjectSchedule> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound("Project");

  const rows = await db.select().from(activities).where(eq(activities.projectId, projectId)).orderBy(asc(activities.code));
  const links = await db.select().from(activityLinks).where(eq(activityLinks.projectId, projectId));
  const codeById = new Map(rows.map((r) => [r.id, r.code]));

  const predecessorsByActivity = new Map<string, NonNullable<EngineActivity["predecessors"]>[number][]>();
  for (const link of links) {
    const list = predecessorsByActivity.get(link.toActivityId) ?? [];
    list.push({ from: codeById.get(link.fromActivityId)!, type: link.type, lag: link.lag });
    predecessorsByActivity.set(link.toActivityId, list);
  }

  return {
    project,
    calendar: projectCalendar(project),
    byCode: new Map(rows.map((r) => [r.code, r])),
    activities: rows.map((row) => ({
      id: row.code,
      name: row.name,
      duration: row.duration,
      predecessors: predecessorsByActivity.get(row.id) ?? [],
      ...(row.actualStart ? { actualStart: row.actualStart } : {}),
      ...(row.actualFinish ? { actualFinish: row.actualFinish } : {}),
      ...(row.remainingDuration !== null ? { remainingDuration: row.remainingDuration } : {}),
    })),
  };
}

/** Workdays between the forecast finish and the contract finish. Positive means late. */
export function slipAgainstContract(result: ScheduleResult, schedule: ProjectSchedule): number {
  const contractLastDay = schedule.calendar.indexOf(schedule.project.contractFinish);
  return result.projectFinish - 1 - contractLastDay;
}

export function serializeSchedule(result: ScheduleResult, schedule: ProjectSchedule) {
  return {
    dataDate: schedule.project.dataDate,
    finishDate: result.finishDate,
    contractFinish: schedule.project.contractFinish,
    slipDays: slipAgainstContract(result, schedule),
    criticalPath: result.criticalPath,
    activities: result.order.map((code) => {
      const a = result.activities.get(code)!;
      const row = schedule.byCode.get(code)!;
      return {
        id: row.id,
        code,
        name: a.name,
        kind: row.kind,
        zone: row.zone,
        status: a.status,
        duration: row.duration,
        percentComplete: row.percentComplete,
        startDate: a.startDate,
        finishDate: a.finishDate,
        earlyStart: a.earlyStart,
        earlyFinish: a.earlyFinish,
        lateStart: a.lateStart,
        lateFinish: a.lateFinish,
        totalFloat: a.totalFloat,
        freeFloat: a.freeFloat,
        critical: a.critical,
        baselineStart: row.baselineStart,
        baselineFinish: row.baselineFinish,
        actualStart: row.actualStart,
        actualFinish: row.actualFinish,
      };
    }),
  };
}

export type SerializedSchedule = ReturnType<typeof serializeSchedule>;

/** Runs the scheduling engine on the stored schedule and keeps a snapshot. */
export async function recalculate(db: Executor, projectId: string, reason: string) {
  const schedule = await loadProjectSchedule(db, projectId);
  if (schedule.activities.length === 0) throw badRequest("This project has no schedule yet");
  const result = computeSchedule(schedule.activities, schedule.calendar, { dataDate: schedule.project.dataDate });
  const serialized = serializeSchedule(result, schedule);

  await db.insert(scheduleSnapshots).values({
    projectId,
    dataDate: schedule.project.dataDate,
    finishDate: result.finishDate,
    slipDays: serialized.slipDays,
    criticalPath: result.criticalPath,
    activities: serialized.activities,
    reason,
  });
  return { schedule, result, serialized };
}

export async function latestSnapshot(db: Executor, projectId: string) {
  const [snapshot] = await db
    .select()
    .from(scheduleSnapshots)
    .where(eq(scheduleSnapshots.projectId, projectId))
    .orderBy(desc(scheduleSnapshots.createdAt))
    .limit(1);
  return snapshot ?? null;
}

/**
 * Replaces the whole schedule. The new logic is checked by the engine before
 * anything is saved, and the computed early dates become the baseline.
 * Refuses to wipe a schedule that already has progress unless forced.
 */
export async function replaceSchedule(
  db: Executor,
  input: { projectId: string; companyId: string; actorId: string; activities: ImportedActivity[]; force?: boolean },
) {
  validateImport(input.activities);

  return db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId));
    if (!project) throw notFound("Project");

    const existing = await tx.select({ actualStart: activities.actualStart }).from(activities).where(eq(activities.projectId, project.id));
    if (!input.force && existing.some((a) => a.actualStart)) {
      throw conflict("This schedule already has progress recorded. Import again with force to replace it.");
    }

    const calendar = projectCalendar(project);
    let computed: ScheduleResult;
    try {
      computed = computeSchedule(
        input.activities.map((a) => ({
          id: a.code,
          name: a.name,
          duration: a.duration,
          predecessors: a.predecessors.map((p) => ({ from: p.code, type: p.type, lag: p.lag })),
        })),
        calendar,
      );
    } catch (error) {
      if (error instanceof ScheduleError) throw new ImportError("The schedule logic has problems", [error.message]);
      throw error;
    }

    await tx.delete(activities).where(eq(activities.projectId, project.id));
    const inserted = await tx
      .insert(activities)
      .values(
        input.activities.map((a) => {
          const scheduled = computed.activities.get(a.code)!;
          return {
            projectId: project.id,
            code: a.code,
            name: a.name,
            kind: a.kind,
            zone: a.zone ?? null,
            duration: a.duration,
            progressUnit: a.progressUnit ?? null,
            plannedQuantity: a.plannedQuantity ?? null,
            baselineStart: scheduled.earlyStart,
            baselineFinish: scheduled.earlyFinish,
          };
        }),
      )
      .returning({ id: activities.id, code: activities.code });

    const idByCode = new Map(inserted.map((r) => [r.code, r.id]));
    const links = input.activities.flatMap((a) =>
      a.predecessors.map((p) => ({
        projectId: project.id,
        fromActivityId: idByCode.get(p.code)!,
        toActivityId: idByCode.get(a.code)!,
        type: p.type,
        lag: p.lag,
      })),
    );
    if (links.length > 0) await tx.insert(activityLinks).values(links);

    await audit(tx, {
      companyId: input.companyId,
      projectId: project.id,
      actor: { type: "user", id: input.actorId },
      action: "schedule.imported",
      reason: `${input.activities.length} activities, finish ${computed.finishDate}`,
    });
    return recalculate(tx, project.id, "Schedule imported");
  });
}
