/**
 * Supplier quotes and orders.
 *
 * Suppliers answer a request for quotation on Telegram in their own words.
 * The quote agent reads the price, code converts it to birr, and once every
 * supplier has answered (or two days have passed) the cheapest quote that
 * can deliver in time is put to the project manager as an order. Approved
 * orders are confirmed to the supplier, and the delivery is matched when a
 * supervisor reports it in a daily log.
 */

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { tracedGenerate } from "../ai/agent-run.js";
import { QUOTE_AGENT, quotePrompt, quoteSchema } from "../agents/quote-agent.js";
import { audit } from "../audit.js";
import {
  approvals,
  auditLog,
  costEntries,
  dailyLogs,
  materials,
  projects,
  purchaseRequests,
  quotes,
  suppliers,
  users,
} from "../db/schema.js";
import { birr, longDate, plural } from "../domain/format.js";
import { EVENTS } from "../events.js";
import { t } from "../i18n.js";
import { projectCalendar } from "../services/schedule.js";
import { notifyProject } from "./notify.js";
import type { FeatureDeps } from "./types.js";

export const PLACE_ORDER = "procurement.place_order";
/** How long suppliers have to answer before the quotes received are compared anyway. */
export const QUOTE_WINDOW_HOURS = 48;

export const reference = (purchaseRequestId: string) => `PR-${purchaseRequestId.slice(0, 8).toUpperCase()}`;

export function registerQuotesFeature(deps: FeatureDeps): void {
  const { bot, approvals: approvalService, events, scheduler } = deps;

  bot?.onMessage(async ({ user, message }) => {
    if (user.role !== "supplier" || message.kind !== "text" || !message.text) return false;
    await handleSupplierReply(deps, user.id, message.text);
    return true;
  });

  approvalService.register(PLACE_ORDER, z.object({ purchaseRequestId: z.uuid(), quoteId: z.uuid() }), async (action, context) => {
    const [row] = await context.db
      .select({ request: purchaseRequests, quote: quotes, supplier: suppliers, material: materials, project: projects })
      .from(purchaseRequests)
      .innerJoin(quotes, eq(quotes.id, action.quoteId))
      .innerJoin(suppliers, eq(suppliers.id, quotes.supplierId))
      .innerJoin(materials, eq(materials.id, purchaseRequests.materialId))
      .innerJoin(projects, eq(projects.id, purchaseRequests.projectId))
      .where(and(eq(purchaseRequests.id, action.purchaseRequestId), eq(quotes.purchaseRequestId, action.purchaseRequestId)));
    if (!row) throw new Error("Purchase request or quote not found");
    if (row.request.status !== "approved") throw new Error(`Purchase request is already ${row.request.status}`);

    await context.db
      .update(purchaseRequests)
      .set({ status: "ordered", selectedQuoteId: row.quote.id })
      .where(eq(purchaseRequests.id, row.request.id));
    await context.db.update(materials).set({ lastUnitPrice: row.quote.unitPriceEtb }).where(eq(materials.id, row.material.id));

    if (bot && row.supplier.userId) {
      const [supplierUser] = await context.db.select().from(users).where(eq(users.id, row.supplier.userId));
      if (supplierUser) {
        await bot.sendToUser(
          supplierUser,
          `Order confirmed, ${reference(row.request.id)}: ${row.request.quantity} ${row.material.unit} of ${row.material.name} at ${birr(row.quote.unitPriceEtb)} per ${row.material.unit}, ` +
            `total ${birr(row.quote.unitPriceEtb * row.request.quantity)}. Please deliver to ${row.project.locationName ?? row.project.name} by ${longDate(row.request.neededBy)}. Thank you.`,
          { projectId: row.project.id },
        );
      }
    }
    return { ordered: true, supplier: row.supplier.name, totalEtb: row.quote.unitPriceEtb * row.request.quantity };
  }, {
    onReject: async (action, context) => {
      await context.db
        .update(purchaseRequests)
        .set({ status: "cancelled" })
        .where(and(eq(purchaseRequests.id, action.purchaseRequestId), eq(purchaseRequests.status, "approved")));
    },
  });

  scheduler.add("procurement.quote-deadline", async () => {
    const cutoff = new Date(deps.now().getTime() - QUOTE_WINDOW_HOURS * 3_600_000);
    const asked = await deps.db
      .select({ requestId: auditLog.subjectId })
      .from(auditLog)
      .innerJoin(purchaseRequests, sql`${purchaseRequests.id}::text = ${auditLog.subjectId}`)
      .where(and(eq(auditLog.action, "procurement.quotes_requested"), lt(auditLog.createdAt, cutoff), eq(purchaseRequests.status, "approved")));
    let proposed = 0;
    for (const { requestId } of asked) {
      if (requestId && (await compareQuotes(deps, requestId))) proposed++;
    }
    return proposed;
  });

  events.subscribe(EVENTS.dailyLogCompleted, "deliveries", z.object({ dailyLogId: z.uuid(), projectId: z.uuid() }), async ({ dailyLogId }) => {
    await matchDeliveries(deps, dailyLogId);
  });
}

export async function handleSupplierReply(deps: FeatureDeps, userId: string, text: string): Promise<"quote" | "forwarded" | "nothing_open"> {
  const { db, bot } = deps;
  const [row] = await db
    .select({ supplier: suppliers, user: users })
    .from(suppliers)
    .innerJoin(users, eq(users.id, suppliers.userId))
    .where(eq(suppliers.userId, userId));
  if (!row) return "nothing_open";
  const { supplier, user } = row;

  const wanted = supplier.materials.map((m) => m.toLowerCase());
  const open = (
    await db
      .select({ request: purchaseRequests, material: materials, project: projects })
      .from(purchaseRequests)
      .innerJoin(materials, eq(materials.id, purchaseRequests.materialId))
      .innerJoin(projects, eq(projects.id, purchaseRequests.projectId))
      .where(and(eq(projects.companyId, supplier.companyId), eq(purchaseRequests.status, "approved")))
      .orderBy(desc(purchaseRequests.createdAt))
  ).filter((r) => wanted.includes(r.material.name.toLowerCase()));

  if (open.length === 0) {
    await bot?.sendToUser(user, "Thank you. There are no open requests for a price at the moment.");
    return "nothing_open";
  }

  // Reading the price can take a while when the model is busy; acknowledge first.
  await bot?.sendToUser(user, t("readingPrice", user.language));
  const { value } = await tracedGenerate(
    db,
    deps.llm,
    { agent: QUOTE_AGENT, trigger: `supplier:${supplier.id}`, companyId: supplier.companyId, projectId: open[0]!.project.id },
    {
      system: quotePrompt({
        supplier: supplier.name,
        open: open.map((o) => ({ reference: reference(o.request.id), material: o.material.name, quantity: o.request.quantity, unit: o.material.unit })),
      }),
      parts: [{ text }],
      schema: quoteSchema,
    },
  );

  const quoted = value.reference?.toUpperCase();
  const target = (quoted && open.find((o) => reference(o.request.id) === quoted)) || open[0]!;
  if (!value.isQuote || value.unitPrice === null) {
    await notifyProject(deps, {
      companyId: supplier.companyId,
      projectId: target.project.id,
      title: `Message from ${supplier.name}`,
      text: `${supplier.name} replied about ${reference(target.request.id)} (${target.material.name}): "${text}"`,
      requestedBy: QUOTE_AGENT,
    });
    await bot?.sendToUser(user, "Thank you. I have passed your message to the project manager.");
    return "forwarded";
  }

  const unitPriceEtb = await deps.fx.toEtb(value.unitPrice, value.currency);
  const leadTimeDays = value.leadTimeDays ?? deps.config.DEFAULT_SUPPLIER_LEAD_DAYS;
  await db.transaction(async (tx) => {
    // A newer price from the same supplier replaces the old one.
    await tx.delete(quotes).where(and(eq(quotes.purchaseRequestId, target.request.id), eq(quotes.supplierId, supplier.id)));
    await tx.insert(quotes).values({
      purchaseRequestId: target.request.id,
      supplierId: supplier.id,
      unitPrice: value.unitPrice!,
      currency: value.currency.toUpperCase(),
      unitPriceEtb,
      leadTimeDays,
      note: value.note,
    });
    await audit(tx, {
      companyId: supplier.companyId,
      projectId: target.project.id,
      actor: { type: "agent", id: QUOTE_AGENT },
      action: "procurement.quote_received",
      subject: { type: "purchase_request", id: target.request.id },
      reason: `${supplier.name}: ${value.unitPrice} ${value.currency} per ${target.material.unit}`,
    });
  });

  await bot?.sendToUser(
    user,
    `Thank you. Recorded for ${reference(target.request.id)}: ${birr(unitPriceEtb)} per ${target.material.unit}, delivery in ${plural(leadTimeDays, "day")}.`,
  );
  await compareQuotes(deps, target.request.id, { onlyWhenAllAnswered: true });
  return "quote";
}

/**
 * Picks the cheapest quote that can deliver before the material runs out
 * (or the fastest if none can) and asks for approval to order. Does nothing
 * if an order is already waiting for a decision.
 */
export async function compareQuotes(deps: FeatureDeps, purchaseRequestId: string, options: { onlyWhenAllAnswered?: boolean } = {}): Promise<boolean> {
  const { db } = deps;
  const [row] = await db
    .select({ request: purchaseRequests, material: materials, project: projects })
    .from(purchaseRequests)
    .innerJoin(materials, eq(materials.id, purchaseRequests.materialId))
    .innerJoin(projects, eq(projects.id, purchaseRequests.projectId))
    .where(eq(purchaseRequests.id, purchaseRequestId));
  if (!row || row.request.status !== "approved") return false;

  const received = await db
    .select({ quote: quotes, supplierName: suppliers.name })
    .from(quotes)
    .innerJoin(suppliers, eq(suppliers.id, quotes.supplierId))
    .where(eq(quotes.purchaseRequestId, purchaseRequestId));
  if (received.length === 0) return false;

  if (options.onlyWhenAllAnswered) {
    const [request] = await db
      .select({ data: auditLog.data })
      .from(auditLog)
      .where(and(eq(auditLog.action, "procurement.quotes_requested"), eq(auditLog.subjectId, purchaseRequestId)))
      .limit(1);
    const askedIds = ((request?.data as { supplierIds?: string[] } | null)?.supplierIds ?? []).length;
    if (received.length < askedIds) return false;
  }

  const existing = await db
    .select({ id: approvals.id, action: approvals.action })
    .from(approvals)
    .where(and(eq(approvals.projectId, row.project.id), inArray(approvals.status, ["pending", "approved", "executed"])));
  if (existing.some((a) => a.action.type === PLACE_ORDER && a.action.purchaseRequestId === purchaseRequestId)) return false;

  const calendar = projectCalendar(row.project);
  const neededIndex = calendar.indexOf(row.request.neededBy);
  const todayIndex = calendar.indexOf(row.project.dataDate);
  const inTime = (q: (typeof received)[number]) => todayIndex + q.quote.leadTimeDays <= neededIndex;

  const ranked = [...received].sort((a, b) => a.quote.unitPriceEtb - b.quote.unitPriceEtb || a.quote.leadTimeDays - b.quote.leadTimeDays);
  const timely = ranked.filter(inTime);
  const best = timely[0] ?? [...received].sort((a, b) => a.quote.leadTimeDays - b.quote.leadTimeDays)[0]!;
  const total = best.quote.unitPriceEtb * row.request.quantity;
  const { material, request } = row;

  const lines = ranked.map(
    (q) =>
      `- ${q.supplierName}: ${birr(q.quote.unitPriceEtb)} per ${material.unit}, ${plural(q.quote.leadTimeDays, "day")}${inTime(q) ? "" : " (too late)"}${q.quote.note ? `, ${q.quote.note}` : ""}`,
  );
  const notes: string[] = [];
  if (!inTime(best)) notes.push(`No supplier can deliver before ${longDate(request.neededBy)}; this is the fastest offer.`);
  if (material.lastUnitPrice && best.quote.unitPriceEtb > material.lastUnitPrice * 1.1) {
    const rise = Math.round((best.quote.unitPriceEtb / material.lastUnitPrice - 1) * 100);
    notes.push(`The price is ${rise}% above the last price paid (${birr(material.lastUnitPrice)}).`);
  }

  await deps.approvals.propose({
    companyId: row.project.companyId,
    projectId: row.project.id,
    kind: "purchase_request",
    title: `Order ${request.quantity} ${material.unit} of ${material.name} from ${best.supplierName}`,
    summary: [
      `${plural(received.length, "quote")} received for ${reference(request.id)}. Best value that arrives in time: ${best.supplierName} at ${birr(best.quote.unitPriceEtb)} per ${material.unit}, total ${birr(total)}.`,
      ...notes,
      "",
      ...lines,
    ].join("\n"),
    action: { type: PLACE_ORDER, purchaseRequestId, quoteId: best.quote.id },
    evidence: [{ label: `Quotes received for ${reference(request.id)}` }],
    requestedBy: QUOTE_AGENT,
    amountEtb: total,
  });
  return true;
}

/** Marks ordered materials as delivered when a daily log reports them, and records the cost. */
export async function matchDeliveries(deps: FeatureDeps, dailyLogId: string): Promise<number> {
  const { db } = deps;
  const [log] = await db.select().from(dailyLogs).where(eq(dailyLogs.id, dailyLogId));
  if (!log || log.materialsReceived.length === 0) return 0;

  const ordered = await db
    .select({ request: purchaseRequests, material: materials, quote: quotes })
    .from(purchaseRequests)
    .innerJoin(materials, eq(materials.id, purchaseRequests.materialId))
    .innerJoin(quotes, eq(quotes.id, purchaseRequests.selectedQuoteId))
    .where(and(eq(purchaseRequests.projectId, log.projectId), eq(purchaseRequests.status, "ordered")));

  let matched = 0;
  for (const received of log.materialsReceived) {
    const order = ordered.find((o) => o.material.name.toLowerCase() === received.material.toLowerCase());
    if (!order) continue;
    await db.transaction(async (tx) => {
      await tx.update(purchaseRequests).set({ status: "delivered" }).where(eq(purchaseRequests.id, order.request.id));
      await tx
        .insert(costEntries)
        .values({
          projectId: log.projectId,
          date: log.logDate,
          category: "material",
          amount: Math.round(order.quote.unitPriceEtb * received.quantity * 100) / 100,
          description: `${received.quantity} ${order.material.unit} of ${order.material.name}, ${reference(order.request.id)}`,
          sourceRef: `delivery:${order.request.id}`,
        })
        .onConflictDoNothing();
    });
    matched++;
  }
  return matched;
}

/**
 * A price the project manager got by phone or in person. Stored like a reply
 * on Telegram, then compared the same way.
 */
export async function recordQuote(
  deps: FeatureDeps,
  input: { purchaseRequestId: string; supplierId: string; unitPrice: number; currency: string; leadTimeDays: number; note?: string | undefined; userId: string; companyId: string },
) {
  const { db } = deps;
  const [row] = await db
    .select({ request: purchaseRequests, material: materials, project: projects })
    .from(purchaseRequests)
    .innerJoin(materials, eq(materials.id, purchaseRequests.materialId))
    .innerJoin(projects, eq(projects.id, purchaseRequests.projectId))
    .where(and(eq(purchaseRequests.id, input.purchaseRequestId), eq(projects.companyId, input.companyId)));
  if (!row) return { error: "not_found" as const };
  if (row.request.status !== "approved") return { error: "closed" as const, status: row.request.status };
  const [supplier] = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.companyId, input.companyId)));
  if (!supplier) return { error: "unknown_supplier" as const };

  const unitPriceEtb = await deps.fx.toEtb(input.unitPrice, input.currency);
  await db.transaction(async (tx) => {
    await tx.delete(quotes).where(and(eq(quotes.purchaseRequestId, row.request.id), eq(quotes.supplierId, supplier.id)));
    await tx.insert(quotes).values({
      purchaseRequestId: row.request.id,
      supplierId: supplier.id,
      unitPrice: input.unitPrice,
      currency: input.currency.toUpperCase(),
      unitPriceEtb,
      leadTimeDays: input.leadTimeDays,
      note: input.note ?? null,
    });
    await audit(tx, {
      companyId: input.companyId,
      projectId: row.project.id,
      actor: { type: "user", id: input.userId },
      action: "procurement.quote_received",
      subject: { type: "purchase_request", id: row.request.id },
      reason: `${supplier.name}: ${input.unitPrice} ${input.currency.toUpperCase()} per ${row.material.unit}, entered by hand`,
    });
  });
  const proposed = await compareQuotes(deps, row.request.id, { onlyWhenAllAnswered: true });
  return { error: null, proposed };
}
