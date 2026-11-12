/**
 * Procurement agent.
 *
 * Watches the material forecast. When a material will run out before a new
 * delivery could arrive, it drafts a purchase request and asks the project
 * manager. Once approved, it asks the suppliers who carry that material for
 * a quote on Telegram.
 */

import { addCalendarDays } from "@sitemate/engine";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit.js";
import { approvals, companies, projects, purchaseRequests, quotes, suppliers, users } from "../db/schema.js";
import { birr, longDate, plural } from "../domain/format.js";
import { localDate } from "../domain/time.js";
import { EVENTS } from "../events.js";
import { enqueue } from "../jobs/queue.js";
import { forecastMaterials, orderQuantity, type MaterialForecast } from "../services/materials.js";
import { compareQuotes } from "./quotes.js";
import type { FeatureDeps } from "./types.js";

export const PROCUREMENT_AGENT = "procurement";
export const PROCUREMENT_CHECK_JOB = "procurement.check";
export const REQUEST_QUOTES = "procurement.request_quotes";

export function registerProcurementFeature(deps: FeatureDeps): void {
  const { db, runner, events, approvals, scheduler } = deps;

  runner.register(PROCUREMENT_CHECK_JOB, {
    schema: z.object({ projectId: z.uuid() }),
    handle: async ({ projectId }) => {
      await checkMaterials(deps, projectId);
    },
  });

  events.subscribe(EVENTS.dailyLogCompleted, "procurement", z.object({ dailyLogId: z.uuid(), projectId: z.uuid() }), async ({ projectId }) => {
    await checkMaterials(deps, projectId);
  });

  scheduler.add("procurement.daily-check", async () => {
    const today = localDate(deps.now(), deps.config.SITE_TIME_ZONE);
    const active = await db.select({ id: projects.id }).from(projects).where(eq(projects.active, true));
    let queued = 0;
    for (const project of active) {
      if ((await enqueue(db, PROCUREMENT_CHECK_JOB, { projectId: project.id }, { idempotencyKey: `procurement:${project.id}:${today}` })) !== null) queued++;
    }
    return queued;
  });

  approvals.register(REQUEST_QUOTES, z.object({ purchaseRequestId: z.uuid() }), async (action, context) => {
    const [row] = await context.db
      .select({ request: purchaseRequests, project: projects })
      .from(purchaseRequests)
      .innerJoin(projects, eq(projects.id, purchaseRequests.projectId))
      .where(eq(purchaseRequests.id, action.purchaseRequestId));
    if (!row) throw new Error("Purchase request not found");
    if (row.request.status !== "pending_approval") throw new Error(`Purchase request is already ${row.request.status}`);

    const forecast = (await forecastMaterials(context.db, row.project.id)).find((f) => f.material.id === row.request.materialId);
    if (!forecast) throw new Error("Material not found");
    await context.db.update(purchaseRequests).set({ status: "approved" }).where(eq(purchaseRequests.id, row.request.id));
    const asked = await requestQuotes(deps, { request: row.request, project: row.project, materialName: forecast.material.name, unit: forecast.material.unit });
    return { asked };
  }, {
    // Turned down: close the request so a later stock check can raise a fresh one.
    onReject: async (action, context) => {
      await context.db
        .update(purchaseRequests)
        .set({ status: "cancelled" })
        .where(and(eq(purchaseRequests.id, action.purchaseRequestId), eq(purchaseRequests.status, "pending_approval")));
    },
  });
}

/** Suppliers of the company that list this material, with a linked Telegram account. */
export async function suppliersFor(deps: Pick<FeatureDeps, "db">, companyId: string, materialName: string) {
  const rows = await deps.db
    .select({ supplier: suppliers, user: users })
    .from(suppliers)
    .innerJoin(users, eq(users.id, suppliers.userId))
    .where(and(eq(suppliers.companyId, companyId), eq(users.active, true)));
  const wanted = materialName.toLowerCase();
  return rows.filter((r) => r.supplier.materials.some((m) => m.toLowerCase() === wanted));
}

async function requestQuotes(
  deps: FeatureDeps,
  input: {
    request: typeof purchaseRequests.$inferSelect;
    project: typeof projects.$inferSelect;
    materialName: string;
    unit: string;
  },
): Promise<number> {
  const { request, project } = input;
  const [company] = await deps.db.select().from(companies).where(eq(companies.id, project.companyId));
  const candidates = await suppliersFor(deps, project.companyId, input.materialName);
  let asked = 0;
  const askedIds: string[] = [];
  for (const { supplier, user } of candidates) {
    if (!deps.bot) break;
    const text =
      `Hello ${supplier.name}. ${company?.name ?? "We"} would like a price for ${request.quantity} ${input.unit} of ${input.materialName}, ` +
      `delivered to ${project.locationName ?? project.name} by ${longDate(request.neededBy)}. ` +
      `Please reply with your price per ${input.unit} in birr and how many days you need to deliver. ` +
      `Reference: PR-${request.id.slice(0, 8).toUpperCase()}`;
    if (await deps.bot.sendToUser(user, text, { projectId: project.id })) {
      asked++;
      askedIds.push(supplier.id);
    }
  }
  await audit(deps.db, {
    companyId: project.companyId,
    projectId: project.id,
    actor: { type: "agent", id: PROCUREMENT_AGENT },
    action: "procurement.quotes_requested",
    subject: { type: "purchase_request", id: request.id },
    reason: `${plural(asked, "supplier")} asked`,
    data: { supplierIds: askedIds },
  });
  return asked;
}

function reasonText(forecast: MaterialForecast, quantity: number): string {
  const { material } = forecast;
  const perDay = Math.round(forecast.dailyUse * 10) / 10;
  const onHand = Math.round(material.onHand);
  // Recorded use can run ahead of recorded deliveries, e.g. when a delivery was never reported.
  const stock =
    onHand > 0
      ? `${material.name}: ${onHand} ${material.unit} on site, about ${perDay} ${material.unit} a day planned over the next three weeks.`
      : `${material.name}: none left on site by the records${onHand < 0 ? ` (${-onHand} ${material.unit} more used than delivered, so check for an unreported delivery)` : ""}, and about ${perDay} ${material.unit} a day planned over the next three weeks.`;
  const timing =
    onHand > 0
      ? `At that rate it runs out on ${longDate(forecast.runOutDate!)}. Suppliers need ${plural(material.leadTimeDays, "day")}, so an order has to go out by ${longDate(forecast.orderBy!)}.`
      : `Suppliers need ${plural(material.leadTimeDays, "day")}, so it should be ordered now.`;
  return [
    stock,
    timing,
    `Suggested order: ${quantity} ${material.unit}${material.lastUnitPrice ? `, about ${birr(quantity * material.lastUnitPrice)} at the last price of ${birr(material.lastUnitPrice)} per ${material.unit}` : ""}.`,
  ].join(" ");
}

/** Drafts purchase requests for materials that will run short. Returns how many were raised. */
export async function checkMaterials(deps: FeatureDeps, projectId: string): Promise<number> {
  const { db } = deps;
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project?.active) return 0;
  const forecasts = await forecastMaterials(db, projectId);
  let raised = 0;

  for (const forecast of forecasts) {
    if (forecast.status !== "order_now" && forecast.status !== "order_soon") continue;
    const { material } = forecast;

    // Never two open requests for the same material.
    const open = await db
      .select({ id: purchaseRequests.id })
      .from(purchaseRequests)
      .where(
        and(
          eq(purchaseRequests.materialId, material.id),
          inArray(purchaseRequests.status, ["draft", "pending_approval", "approved", "ordered"]),
        ),
      );
    if (open.length > 0) continue;

    const quantity = orderQuantity(forecast);
    const neededBy = forecast.runOutDate ?? addCalendarDays(project.dataDate, material.leadTimeDays);
    const reason = reasonText(forecast, quantity);
    const [request] = await db
      .insert(purchaseRequests)
      .values({ projectId, materialId: material.id, quantity, neededBy, status: "pending_approval", reason })
      .returning();

    await deps.approvals.propose({
      companyId: project.companyId,
      projectId,
      kind: "purchase_request",
      title: `${forecast.status === "order_now" ? "Order now" : "Order soon"}: ${quantity} ${material.unit} of ${material.name}`,
      summary: `${reason}\n\nIf you approve, SiteMate will ask the suppliers who carry ${material.name} for quotes and come back with a comparison.`,
      action: { type: REQUEST_QUOTES, purchaseRequestId: request!.id },
      evidence: [{ label: `Usage learned from daily logs: ${forecast.usagePerUnit?.toFixed(2)} ${material.unit} per ${material.progressUnit ?? "unit"}` }],
      requestedBy: PROCUREMENT_AGENT,
      ...(material.lastUnitPrice ? { amountEtb: quantity * material.lastUnitPrice } : {}),
    });
    raised++;
  }
  return raised;
}

/**
 * Brings back a request that was turned down by mistake. With prices already
 * in, it goes straight to choosing a quote; otherwise it asks again for the
 * go-ahead to collect prices, with the same reasoning as before.
 */
export async function reopenPurchaseRequest(deps: FeatureDeps, input: { purchaseRequestId: string; companyId: string }) {
  const { db } = deps;
  const [row] = await db
    .select({ request: purchaseRequests, project: projects })
    .from(purchaseRequests)
    .innerJoin(projects, eq(projects.id, purchaseRequests.projectId))
    .where(and(eq(purchaseRequests.id, input.purchaseRequestId), eq(projects.companyId, input.companyId)));
  if (!row) return { error: "not_found" as const };
  if (row.request.status !== "cancelled") return { error: "not_cancelled" as const };
  const [newer] = await db
    .select({ id: purchaseRequests.id })
    .from(purchaseRequests)
    .where(
      and(
        eq(purchaseRequests.materialId, row.request.materialId),
        inArray(purchaseRequests.status, ["draft", "pending_approval", "approved", "ordered"]),
      ),
    );
  if (newer) return { error: "newer_open" as const };

  const [priced] = await db.select({ id: quotes.id }).from(quotes).where(eq(quotes.purchaseRequestId, row.request.id)).limit(1);
  if (priced) {
    await db.update(purchaseRequests).set({ status: "approved" }).where(eq(purchaseRequests.id, row.request.id));
    await compareQuotes(deps, row.request.id);
    return { error: null, step: "order" as const };
  }

  const [earlier] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.projectId, row.project.id), sql`${approvals.action}->>'purchaseRequestId' = ${row.request.id}`))
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  await db.update(purchaseRequests).set({ status: "pending_approval" }).where(eq(purchaseRequests.id, row.request.id));
  await deps.approvals.propose({
    companyId: row.project.companyId,
    projectId: row.project.id,
    kind: "purchase_request",
    title: earlier?.title ?? "Order again",
    summary: earlier?.summary ?? row.request.reason,
    action: { type: REQUEST_QUOTES, purchaseRequestId: row.request.id },
    evidence: earlier?.evidence ?? [],
    requestedBy: PROCUREMENT_AGENT,
  });
  return { error: null, step: "quotes" as const };
}
