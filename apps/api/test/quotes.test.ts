import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvals, costEntries, materials, materialTransactions, purchaseRequests } from "../src/db/schema.js";
import { checkMaterials } from "../src/features/procurement.js";
import { OpenExchangeRates } from "../src/integrations/fx.js";
import { recomputeStock } from "../src/services/daily-logs.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { addLinkedUser, deliver, setupSiteProject } from "./helpers/fixtures.js";
import { textUpdate } from "./helpers/telegram.js";

let now = new Date("2026-01-05T09:00:00Z");
let t: TestApp;
let telegramIds = 990_000;

beforeAll(async () => {
  t = await createTestApp({ SITE_BATCH_SECONDS: "0" }, { now: () => now });
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  now = new Date("2026-01-05T09:00:00Z");
  t.llm.reset();
  t.telegram.reset();
});

const QUOTE = "You read replies from building material suppliers";

/** Answers like a model reading the supplier's message. */
function quoteReader() {
  t.llm.when(QUOTE, (request: { parts: Array<{ text?: string }> }) => {
    const text = request.parts[0]!.text!;
    const match = /(\d+(?:\.\d+)?)\s*(birr|usd)/i.exec(text);
    const days = /(\d+)\s*days?/i.exec(text);
    if (!match) return { isQuote: false, unitPrice: null, currency: "ETB", pricePer: null, leadTimeDays: null, reference: null, note: null };
    return {
      isQuote: true,
      unitPrice: Number(match[1]),
      currency: match[2]!.toLowerCase() === "usd" ? "USD" : "ETB",
      pricePer: "bag",
      leadTimeDays: days ? Number(days[1]) : null,
      reference: null,
      note: /transport/i.test(text) ? "Transport not included" : null,
    };
  });
}

async function addSupplier(ownerAuth: Record<string, string>, name: string) {
  const supplier = (
    await t.app.inject({ method: "POST", url: "/suppliers", headers: ownerAuth, payload: { name, materials: ["Cement"] } })
  ).json().supplier as { id: string; userId: string };
  const code = (await t.app.inject({ method: "POST", url: `/users/${supplier.userId}/telegram-invite`, headers: ownerAuth })).json().code;
  const telegramId = ++telegramIds;
  await deliver(t, textUpdate(telegramId, `/start ${code}`));
  return { ...supplier, telegramId };
}

/** A project short of cement, two suppliers, and an approved request for quotes. */
async function quotesRequested() {
  const site = await setupSiteProject(t);
  const cement = site.materials.cement;
  await t.handle.db.insert(materialTransactions).values([
    { materialId: cement.id, date: "2026-01-02", kind: "usage", quantity: 180, progress: 360, note: "Earlier work" },
  ]);
  await recomputeStock(t.handle.db, [cement.id]);
  const pm = await addLinkedUser(t, site.owner.auth, { name: "Sara", role: "project_manager", projectId: site.projectId });
  const habesha = await addSupplier(site.owner.auth, "Habesha Cement Agent");
  const derba = await addSupplier(site.owner.auth, "Derba Trading");

  await checkMaterials(t.runtime.deps, site.projectId);
  const [request] = await t.handle.db.select().from(approvals).where(eq(approvals.projectId, site.projectId));
  await t.app.inject({ method: "POST", url: `/approvals/${request!.id}/decision`, headers: pm.auth!, payload: { decision: "approve" } });
  const [purchase] = await t.handle.db.select().from(purchaseRequests).where(eq(purchaseRequests.projectId, site.projectId));
  t.telegram.reset();
  return { site, pm, habesha, derba, purchase: purchase! };
}

async function orderApprovals(projectId: string) {
  return (await t.handle.db.select().from(approvals).where(eq(approvals.projectId, projectId))).filter(
    (a) => a.action.type === "procurement.place_order",
  );
}

describe("supplier quotes", () => {
  it("reads quotes in birr and dollars, waits for everyone, then proposes the best order", async () => {
    const { site, pm, habesha, derba, purchase } = await quotesRequested();
    quoteReader();

    await deliver(t, textUpdate(habesha.telegramId, "4200 birr per bag, 2 days, transport included"));
    expect(t.telegram.textsTo(habesha.telegramId).at(-1)).toMatch(/^Thank you\. Recorded for PR-[0-9A-F]{8}: 4,200 birr per bag, delivery in 2 days\.$/);
    expect(await orderApprovals(site.projectId)).toHaveLength(0);

    await deliver(t, textUpdate(derba.telegramId, "25 USD per bag, 5 days, transport extra"));
    const [order] = await orderApprovals(site.projectId);
    expect(order!.title).toBe(`Order ${purchase.quantity} bag of Cement from Derba Trading`);
    expect(order!.summary).toContain("- Derba Trading: 4,000 birr per bag, 5 days, Transport not included");
    expect(order!.summary).toContain("- Habesha Cement Agent: 4,200 birr per bag, 2 days");

    const decided = await t.app.inject({ method: "POST", url: `/approvals/${order!.id}/decision`, headers: pm.auth!, payload: { decision: "approve" } });
    expect(decided.json().approval.status).toBe("executed");
    expect(t.telegram.textsTo(derba.telegramId).at(-1)).toMatch(/^Order confirmed, PR-[0-9A-F]{8}: \d+ bag of Cement at 4,000 birr per bag/);
    const [ordered] = await t.handle.db.select().from(purchaseRequests).where(eq(purchaseRequests.id, purchase.id));
    expect(ordered!.status).toBe("ordered");
    const [cement] = await t.handle.db.select().from(materials).where(eq(materials.id, site.materials.cement.id));
    expect(cement!.lastUnitPrice).toBe(4000);

    // The delivery is reported in the next daily log.
    t.llm.when("site agent of SiteMate", {
      summary: "Cement delivered.",
      weather: null,
      workers: [],
      progress: [],
      materialsReceived: [{ material: "Cement", quantity: purchase.quantity, unit: "bag" }],
      materialsUsed: [],
      issues: [],
      photoChecks: [],
      missing: [],
      followUpQuestion: null,
      confidence: 0.9,
    });
    await deliver(t, textUpdate(site.supervisor.telegramId, "Cement arrived"));
    const [delivered] = await t.handle.db.select().from(purchaseRequests).where(eq(purchaseRequests.id, purchase.id));
    expect(delivered!.status).toBe("delivered");
    const costs = await t.handle.db.select().from(costEntries).where(eq(costEntries.projectId, site.projectId));
    expect(costs).toEqual([expect.objectContaining({ category: "material", amount: purchase.quantity * 4000 })]);
  });

  it("compares what it has once the quote window has passed", async () => {
    const { site, habesha } = await quotesRequested();
    quoteReader();
    await deliver(t, textUpdate(habesha.telegramId, "4300 birr, 2 days"));
    expect(await orderApprovals(site.projectId)).toHaveLength(0);

    // The request was logged with the database clock, so move past it by more than the window.
    now = new Date(Date.now() + 49 * 3_600_000);
    await t.runtime.scheduler.tick();
    const [order] = await orderApprovals(site.projectId);
    expect(order!.title).toMatch(/from Habesha Cement Agent$/);
  });

  it("passes on messages that are not a quote", async () => {
    const { pm, habesha } = await quotesRequested();
    quoteReader();
    await deliver(t, textUpdate(habesha.telegramId, "Can we call you tomorrow about the delivery road?"));
    expect(t.telegram.textsTo(habesha.telegramId).at(-1)).toBe("Thank you. I have passed your message to the project manager.");
    expect(t.telegram.textsTo(pm.telegramId).at(-1)).toMatch(/Habesha Cement Agent replied about PR-[0-9A-F]{8} \(Cement\)/);
  });

  it("tells a supplier when nothing is open", async () => {
    const site = await setupSiteProject(t);
    const lonely = await addSupplier(site.owner.auth, "Quiet Supplier");
    await deliver(t, textUpdate(lonely.telegramId, "Do you need cement?"));
    expect(t.telegram.textsTo(lonely.telegramId).at(-1)).toBe("Thank you. There are no open requests for a price at the moment.");
  });
});

describe("exchange rates", () => {
  it("converts through US dollar rates and caches them", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ result: "success", rates: { USD: 1, ETB: 161.65, EUR: 0.92 } }));
    }) as unknown as typeof fetch;
    const fx = new OpenExchangeRates(fakeFetch);
    expect(await fx.toEtb(25, "usd")).toBe(4041.25);
    expect(await fx.toEtb(10, "EUR")).toBe(1757.07);
    expect(await fx.toEtb(500, "ETB")).toBe(500);
    expect(calls).toBe(1);
    await expect(fx.toEtb(1, "XYZ")).rejects.toThrow(/No exchange rate/);
  });
});
