import { addCalendarDays } from "@sitemate/engine";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { CheckedLog } from "../agents/site-agent.js";
import { audit } from "../audit.js";
import type { Executor } from "../db/client.js";
import { activities, dailyLogs, materials, materialTransactions, messages, projects } from "../db/schema.js";

export type DailyLog = typeof dailyLogs.$inferSelect;

/** Today's log for a supervisor on a project, created on first message. */
export async function findOrCreateLog(
  db: Executor,
  input: { projectId: string; supervisorId: string; logDate: string },
): Promise<DailyLog> {
  await db
    .insert(dailyLogs)
    .values({ projectId: input.projectId, supervisorId: input.supervisorId, logDate: input.logDate })
    .onConflictDoNothing();
  const [log] = await db
    .select()
    .from(dailyLogs)
    .where(
      and(
        eq(dailyLogs.projectId, input.projectId),
        eq(dailyLogs.supervisorId, input.supervisorId),
        eq(dailyLogs.logDate, input.logDate),
      ),
    );
  return log!;
}

export async function logMessages(db: Executor, dailyLogId: string) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.dailyLogId, dailyLogId), eq(messages.direction, "in")))
    .orderBy(asc(messages.createdAt));
}

/** Remaining workdays estimated from progress, used until the supervisor reports otherwise. */
export function remainingFromProgress(duration: number, percent: number): number {
  if (percent >= 100) return 0;
  return Math.max(1, Math.ceil((duration * (100 - percent)) / 100));
}

/**
 * Applies a completed log to the project. Running it again for the same log
 * gives the same result: material movements from the log are replaced, not
 * added twice, and progress is cumulative.
 */
export async function applyLog(
  db: Executor,
  input: { log: DailyLog; checked: CheckedLog; companyId: string },
): Promise<void> {
  const { log, checked } = input;

  await db.transaction(async (tx) => {
    await tx
      .update(dailyLogs)
      .set({
        status: "complete",
        summary: checked.summary,
        weather: checked.weather,
        workers: checked.workers,
        progress: checked.progress,
        materialsReceived: checked.materialsReceived,
        materialsUsed: checked.materialsUsed,
        issues: checked.issues,
        followUpQuestion: null,
        confidence: checked.confidence,
      })
      .where(eq(dailyLogs.id, log.id));

    // Progress on activities.
    const codes = checked.progress.map((p) => p.activityCode);
    const rows = codes.length
      ? await tx
          .select()
          .from(activities)
          .where(and(eq(activities.projectId, log.projectId), inArray(activities.code, codes)))
      : [];
    const byCode = new Map(rows.map((r) => [r.code, r]));
    for (const item of checked.progress) {
      const row = byCode.get(item.activityCode);
      if (!row) continue;
      const started = item.percentComplete > 0;
      const finished = item.percentComplete >= 100;
      await tx
        .update(activities)
        .set({
          percentComplete: item.percentComplete,
          actualStart: row.actualStart ?? (started ? log.logDate : null),
          actualFinish: finished ? (row.actualFinish ?? log.logDate) : null,
          remainingDuration: started ? remainingFromProgress(row.duration, item.percentComplete) : row.remainingDuration,
        })
        .where(eq(activities.id, row.id));
    }

    // Material movements, replacing whatever this log recorded before.
    await tx.delete(materialTransactions).where(eq(materialTransactions.dailyLogId, log.id));
    const tracked = await tx.select().from(materials).where(eq(materials.projectId, log.projectId));
    const byName = new Map(tracked.map((m) => [m.name.toLowerCase(), m]));

    const progressFor = (material: (typeof tracked)[number]) => {
      if (!material.progressUnit) return null;
      const total = checked.progress
        .filter((p) => byCode.get(p.activityCode)?.progressUnit === material.progressUnit && p.quantityDone !== undefined)
        .reduce((sum, p) => sum + (p.quantityDone ?? 0), 0);
      return total > 0 ? total : null;
    };

    const movements = [
      ...checked.materialsUsed.map((m) => ({ ...m, kind: "usage" as const })),
      ...checked.materialsReceived.map((m) => ({ ...m, kind: "delivery" as const })),
    ];
    for (const movement of movements) {
      const material = byName.get(movement.material.toLowerCase());
      if (!material) continue;
      await tx.insert(materialTransactions).values({
        materialId: material.id,
        date: log.logDate,
        kind: movement.kind,
        quantity: movement.quantity,
        progress: movement.kind === "usage" ? progressFor(material) : null,
        dailyLogId: log.id,
        note: `From daily log ${log.logDate}`,
      });
    }
    // A re-applied log may no longer mention a material it moved before, so every one is recomputed.
    await recomputeStock(
      tx,
      tracked.map((m) => m.id),
    );

    // The status date moves to the start of the next day.
    await tx
      .update(projects)
      .set({ dataDate: sql`greatest(${projects.dataDate}, ${addCalendarDays(log.logDate, 1)}::date)` })
      .where(eq(projects.id, log.projectId));

    await audit(tx, {
      companyId: input.companyId,
      projectId: log.projectId,
      actor: { type: "agent", id: "site" },
      action: "daily_log.applied",
      subject: { type: "daily_log", id: log.id },
      reason: checked.summary,
      data: { corrections: checked.corrections, confidence: checked.confidence },
    });
  });
}

/** Stock on hand is always the sum of the movements, so it can be rebuilt at any time. */
export async function recomputeStock(db: Executor, materialIds: string[]): Promise<void> {
  for (const id of new Set(materialIds)) {
    await db
      .update(materials)
      .set({
        onHand: sql`coalesce((
          select sum(case when kind = 'usage' then -quantity else quantity end)
          from ${materialTransactions} where material_id = ${id}
        ), 0)`,
      })
      .where(eq(materials.id, id));
  }
}
