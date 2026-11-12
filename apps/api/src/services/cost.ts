/**
 * Cost control: earned value and payment claims.
 *
 * Budget comes from the bill of quantities, spread over the activities each
 * item is linked to. Planned value follows the baseline schedule, earned
 * value follows measured progress, and actual cost is the sum of recorded
 * costs. Payment claims use the same measured quantities, so the claim and
 * the progress figures always agree.
 */

import { summarizeEarnedValue, type BudgetedActivity } from "@sitemate/engine";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { Executor } from "../db/client.js";
import {
  activities,
  boqItems,
  costEntries,
  dailyLogs,
  paymentClaims,
  scheduleSnapshots,
  type PaymentClaimLine,
} from "../db/schema.js";
import { conflict } from "../http/errors.js";
import { projectCalendar, type Project } from "./schedule.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function budgetedActivities(db: Executor, projectId: string): Promise<BudgetedActivity[]> {
  const rows = await db.select().from(activities).where(eq(activities.projectId, projectId));
  const items = await db.select().from(boqItems).where(eq(boqItems.projectId, projectId));
  const budgetByActivity = new Map<string, number>();
  for (const item of items) {
    if (!item.activityId) continue;
    budgetByActivity.set(item.activityId, (budgetByActivity.get(item.activityId) ?? 0) + item.quantity * item.rate);
  }
  return rows
    .filter((a) => (budgetByActivity.get(a.id) ?? 0) > 0 && a.baselineStart !== null && a.baselineFinish !== null)
    .map((a) => ({
      id: a.code,
      budget: budgetByActivity.get(a.id)!,
      baselineStart: a.baselineStart!,
      baselineFinish: a.baselineFinish!,
      percentComplete: a.percentComplete,
    }));
}

export async function actualCostTo(db: Executor, projectId: string, date: string): Promise<number> {
  const rows = await db
    .select({ amount: costEntries.amount })
    .from(costEntries)
    .where(and(eq(costEntries.projectId, projectId), lte(costEntries.date, date)));
  return round2(rows.reduce((sum, r) => sum + r.amount, 0));
}

export async function earnedValueReport(db: Executor, project: Project) {
  const calendar = projectCalendar(project);
  const budgeted = await budgetedActivities(db, project.id);
  const dataDay = calendar.indexOf(project.dataDate);
  const actual = await actualCostTo(db, project.id, project.dataDate);
  const summary = summarizeEarnedValue(budgeted, dataDay, actual);

  // History: planned value along the baseline, earned value at each schedule update.
  const snapshots = await db
    .select({ dataDate: scheduleSnapshots.dataDate, activities: scheduleSnapshots.activities, createdAt: scheduleSnapshots.createdAt })
    .from(scheduleSnapshots)
    .where(eq(scheduleSnapshots.projectId, project.id))
    .orderBy(asc(scheduleSnapshots.createdAt));
  const latestByDate = new Map<string, Array<{ code: string; percentComplete: number }>>();
  for (const s of snapshots) latestByDate.set(s.dataDate, s.activities as Array<{ code: string; percentComplete: number }>);

  const costs = await db
    .select({ date: costEntries.date, amount: costEntries.amount })
    .from(costEntries)
    .where(eq(costEntries.projectId, project.id))
    .orderBy(asc(costEntries.date));

  const series = [...latestByDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, recorded]) => {
      const progress = new Map(recorded.map((a) => [a.code, a.percentComplete]));
      const asOf = budgeted.map((b) => ({ ...b, percentComplete: progress.get(b.id) ?? 0 }));
      const report = summarizeEarnedValue(asOf, calendar.indexOf(date), 0);
      const spent = costs.filter((c) => c.date <= date).reduce((sum, c) => sum + c.amount, 0);
      return { date, plannedValue: round2(report.plannedValue), earnedValue: round2(report.earnedValue), actualCost: round2(spent) };
    });

  const byCategory: Record<string, number> = {};
  for (const entry of await db.select().from(costEntries).where(eq(costEntries.projectId, project.id))) {
    byCategory[entry.category] = round2((byCategory[entry.category] ?? 0) + entry.amount);
  }

  return {
    dataDate: project.dataDate,
    summary: {
      ...summary,
      plannedValue: round2(summary.plannedValue),
      earnedValue: round2(summary.earnedValue),
      scheduleVariance: round2(summary.scheduleVariance),
      costVariance: round2(summary.costVariance),
      spi: summary.spi === null ? null : Math.round(summary.spi * 1000) / 1000,
      cpi: summary.cpi === null ? null : Math.round(summary.cpi * 1000) / 1000,
      estimateAtCompletion: summary.estimateAtCompletion === null ? null : round2(summary.estimateAtCompletion),
      varianceAtCompletion: summary.varianceAtCompletion === null ? null : round2(summary.varianceAtCompletion),
    },
    series,
    costByCategory: byCategory,
  };
}

/** Labour cost of a day: workers by trade times the project's daily rates. */
export function labourCost(workers: Array<{ trade: string; count: number }>, rates: Record<string, number>): number {
  const normalized = new Map(Object.entries(rates).map(([trade, rate]) => [trade.toLowerCase().replace(/s$/, ""), rate]));
  let total = 0;
  for (const { trade, count } of workers) {
    const key = trade.toLowerCase().trim().replace(/s$/, "");
    const rate = normalized.get(key) ?? normalized.get("default") ?? 0;
    total += rate * count;
  }
  return round2(total);
}

/**
 * Drafts the next interim payment claim up to a date. Each BOQ item is
 * measured from its activity's progress; the previous claim's quantities
 * are carried forward so only this period's work is claimed.
 */
export async function draftPaymentClaim(db: Executor, project: Project, periodEnd: string) {
  const [previous] = await db
    .select()
    .from(paymentClaims)
    .where(eq(paymentClaims.projectId, project.id))
    .orderBy(desc(paymentClaims.number))
    .limit(1);
  if (previous && previous.periodEnd >= periodEnd) {
    throw conflict(`Claim ${previous.number} already covers the period up to ${previous.periodEnd}`);
  }
  const previousLines = new Map((previous?.lines ?? []).map((l) => [l.boqItemId, l]));

  const items = await db.select().from(boqItems).where(eq(boqItems.projectId, project.id)).orderBy(asc(boqItems.itemNo));
  const rows = await db.select().from(activities).where(eq(activities.projectId, project.id));
  const activityById = new Map(rows.map((a) => [a.id, a]));

  const inPeriod = (date: string) => (previous ? date > previous.periodEnd : date >= project.startDate) && date <= periodEnd;
  const logs = await db
    .select({ id: dailyLogs.id, logDate: dailyLogs.logDate, progress: dailyLogs.progress })
    .from(dailyLogs)
    .where(and(eq(dailyLogs.projectId, project.id), eq(dailyLogs.status, "complete")));

  const lines: PaymentClaimLine[] = items.map((item) => {
    const activity = item.activityId ? activityById.get(item.activityId) : undefined;
    const percent = activity?.percentComplete ?? 0;
    const cumulativeQuantity = Math.round(item.quantity * (percent / 100) * 1000) / 1000;
    const previousQuantity = previousLines.get(item.id)?.cumulativeQuantity ?? 0;
    const evidence = activity
      ? logs
          .filter((l) => inPeriod(l.logDate) && l.progress.some((p) => p.activityCode === activity.code))
          .map((l) => `daily_log:${l.id}:${l.logDate}`)
      : [];
    return {
      boqItemId: item.id,
      itemNo: item.itemNo,
      description: item.description,
      unit: item.unit,
      rate: item.rate,
      contractQuantity: item.quantity,
      previousQuantity,
      cumulativeQuantity,
      thisPeriodAmount: round2((cumulativeQuantity - previousQuantity) * item.rate),
      evidence,
    };
  });

  const cumulativeGross = round2(lines.reduce((sum, l) => sum + l.cumulativeQuantity * l.rate, 0));
  const previousGross = previous?.cumulativeGross ?? 0;
  const retentionRate = project.retentionPercent / 100;
  const retention = round2(cumulativeGross * retentionRate);
  const netThisPeriod = round2((cumulativeGross - previousGross) * (1 - retentionRate));

  const [claim] = await db
    .insert(paymentClaims)
    .values({
      projectId: project.id,
      number: (previous?.number ?? 0) + 1,
      periodEnd,
      status: "draft",
      cumulativeGross,
      previousGross,
      retention,
      netThisPeriod,
      lines,
    })
    .returning();
  return claim!;
}

/** Plain CSV of a claim for the consultant, opened in Excel. */
export function claimToCsv(claim: typeof paymentClaims.$inferSelect, projectName: string): string {
  const quote = (value: string | number) => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows: Array<Array<string | number>> = [
    [`Interim payment claim ${claim.number}`, projectName, `Period ending ${claim.periodEnd}`],
    [],
    ["Item", "Description", "Unit", "Rate", "Contract qty", "Previous qty", "Cumulative qty", "This period (birr)", "Evidence"],
    ...claim.lines.map((l) => [
      l.itemNo,
      l.description,
      l.unit,
      l.rate,
      l.contractQuantity,
      l.previousQuantity,
      l.cumulativeQuantity,
      l.thisPeriodAmount,
      l.evidence.map((e) => e.split(":").at(-1)).join(" "),
    ]),
    [],
    ["", "Cumulative value of work", "", "", "", "", "", claim.cumulativeGross],
    ["", "Less previous claims", "", "", "", "", "", claim.previousGross],
    ["", "Retention held to date", "", "", "", "", "", claim.retention],
    ["", "Net amount due this period", "", "", "", "", "", claim.netThisPeriod],
  ];
  return rows.map((r) => r.map(quote).join(",")).join("\r\n");
}
