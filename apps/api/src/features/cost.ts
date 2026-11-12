/**
 * Cost agent: books labour from the daily logs, and near the end of each
 * month drafts the interim payment claim for the site engineer to check and
 * the project manager to approve.
 */

import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { boqItems, costEntries, dailyLogs, paymentClaims, projects } from "../db/schema.js";
import { birr, longDate, plural } from "../domain/format.js";
import { localDate } from "../domain/time.js";
import { EVENTS } from "../events.js";
import { draftPaymentClaim, labourCost } from "../services/cost.js";
import type { Project } from "../services/schedule.js";
import type { FeatureDeps } from "./types.js";

export const COST_AGENT = "cost";
export const SUBMIT_CLAIM = "cost.submit_claim";

/** Days before month end the claim is drafted, so it can be checked before submission. */
const CLAIM_DAYS_BEFORE_MONTH_END = 3;

export function registerCostFeature(deps: FeatureDeps): void {
  const { db, events, approvals, scheduler } = deps;

  events.subscribe(EVENTS.dailyLogCompleted, "cost", z.object({ dailyLogId: z.uuid(), projectId: z.uuid() }), async ({ dailyLogId }) => {
    await bookLabour(deps, dailyLogId);
  });

  approvals.register(SUBMIT_CLAIM, z.object({ paymentClaimId: z.uuid() }), async (action, context) => {
    const [claim] = await context.db
      .update(paymentClaims)
      .set({ status: "submitted" })
      .where(and(eq(paymentClaims.id, action.paymentClaimId), eq(paymentClaims.status, "pending_approval")))
      .returning();
    if (!claim) throw new Error("This claim is no longer waiting for approval");
    return { number: claim.number, netThisPeriod: claim.netThisPeriod };
  });

  scheduler.add("cost.monthly-claim", async () => {
    const today = localDate(deps.now(), deps.config.SITE_TIME_ZONE);
    if (!nearMonthEnd(today)) return 0;
    const monthStart = `${today.slice(0, 7)}-01`;
    const active = await db.select().from(projects).where(eq(projects.active, true));
    let drafted = 0;
    for (const project of active) {
      const [hasBoq] = await db.select({ id: boqItems.id }).from(boqItems).where(eq(boqItems.projectId, project.id)).limit(1);
      if (!hasBoq) continue;
      const [thisMonth] = await db
        .select({ id: paymentClaims.id })
        .from(paymentClaims)
        .where(and(eq(paymentClaims.projectId, project.id), gte(paymentClaims.periodEnd, monthStart)))
        .limit(1);
      if (thisMonth) continue;
      await proposeClaim(deps, project, today);
      drafted++;
    }
    return drafted;
  });
}

export function nearMonthEnd(date: string): boolean {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day > lastDay - CLAIM_DAYS_BEFORE_MONTH_END;
}

/** Books the day's labour once per log; re-processing a log updates the same entry. */
export async function bookLabour(deps: FeatureDeps, dailyLogId: string): Promise<number> {
  const [row] = await deps.db
    .select({ log: dailyLogs, project: projects })
    .from(dailyLogs)
    .innerJoin(projects, eq(projects.id, dailyLogs.projectId))
    .where(eq(dailyLogs.id, dailyLogId));
  if (!row) return 0;
  const amount = labourCost(row.log.workers, row.project.labourRates);
  if (amount <= 0) return 0;
  const workers = row.log.workers.reduce((sum, w) => sum + w.count, 0);
  await deps.db
    .insert(costEntries)
    .values({
      projectId: row.project.id,
      date: row.log.logDate,
      category: "labour",
      amount,
      description: `${plural(workers, "worker")} on site, daily log ${row.log.logDate}`,
      sourceRef: `labour:${row.log.id}`,
    })
    .onConflictDoUpdate({ target: costEntries.sourceRef, set: { amount, description: `${plural(workers, "worker")} on site, daily log ${row.log.logDate}` } });
  return amount;
}

/** Drafts a claim up to a date and asks for approval to submit it. */
export async function proposeClaim(deps: FeatureDeps, project: Project, periodEnd: string) {
  const draft = await draftPaymentClaim(deps.db, project, periodEnd);
  const [claim] = await deps.db
    .update(paymentClaims)
    .set({ status: "pending_approval" })
    .where(eq(paymentClaims.id, draft.id))
    .returning();
  const moved = claim!.lines.filter((l) => l.thisPeriodAmount !== 0);
  const evidence = new Set(claim!.lines.flatMap((l) => l.evidence));
  const top = [...moved].sort((a, b) => b.thisPeriodAmount - a.thisPeriodAmount).slice(0, 5);

  await deps.approvals.propose({
    companyId: project.companyId,
    projectId: project.id,
    kind: "payment_claim",
    title: `Interim payment claim ${claim!.number} up to ${longDate(periodEnd)}`,
    summary: [
      `Work valued this period: ${birr(claim!.cumulativeGross - claim!.previousGross)}. Net due after ${project.retentionPercent}% retention: ${birr(claim!.netThisPeriod)}.`,
      `${plural(moved.length, "BOQ item")} moved this period, backed by ${plural(evidence.size, "daily log")}. Please have the site engineer check the quantities before approving.`,
      "",
      ...top.map((l) => `- ${l.itemNo} ${l.description}: ${l.cumulativeQuantity} of ${l.contractQuantity} ${l.unit}, ${birr(l.thisPeriodAmount)} this period`),
    ].join("\n"),
    action: { type: SUBMIT_CLAIM, paymentClaimId: claim!.id },
    evidence: [{ label: `Measured progress from ${plural(evidence.size, "daily log")}` }],
    requestedBy: COST_AGENT,
    expiresInHours: 24 * 7,
  });
  return claim!;
}
