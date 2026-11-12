import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvals, materialTransactions, purchaseRequests } from "../src/db/schema.js";
import { checkMaterials } from "../src/features/procurement.js";
import { consumes } from "../src/services/materials.js";
import { recomputeStock } from "../src/services/daily-logs.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { addLinkedUser, deliver, setupSiteProject } from "./helpers/fixtures.js";
import { textUpdate } from "./helpers/telegram.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => t.telegram.reset());

describe("consumes", () => {
  it("matches by activity kind when listed, otherwise by unit", () => {
    expect(consumes({ consumedBy: ["masonry"], progressUnit: null }, { kind: "masonry", progressUnit: null })).toBe(true);
    expect(consumes({ consumedBy: ["masonry"], progressUnit: "m2" }, { kind: "finishing", progressUnit: "m2" })).toBe(false);
    expect(consumes({ consumedBy: [], progressUnit: "m2" }, { kind: "finishing", progressUnit: "m2" })).toBe(true);
    expect(consumes({ consumedBy: [], progressUnit: null }, { kind: "finishing", progressUnit: null })).toBe(false);
  });
});

/**
 * Cement is used at 0.5 bags per m2 of blockwork. A50 Boundary wall (90 m2
 * over 3 days) is planned on 10 to 12 January, so 15 bags a day. With 20 bags
 * on site the cement runs out on 11 January, and with a 3 day lead time plus
 * 2 days of margin the order has to go out by 6 January.
 */
async function lowCementSite() {
  const site = await setupSiteProject(t);
  const cement = site.materials.cement;
  await t.handle.db.insert(materialTransactions).values([
    { materialId: cement.id, date: "2026-01-02", kind: "usage", quantity: 50, progress: 100, note: "Earlier project work" },
    { materialId: cement.id, date: "2026-01-03", kind: "usage", quantity: 130, progress: 260, note: "Earlier project work" },
  ]);
  await recomputeStock(t.handle.db, [cement.id]);
  return site;
}

describe("material forecast", () => {
  it("learns usage from the logs and predicts the run-out date", async () => {
    const site = await lowCementSite();
    const response = await t.app.inject({ url: `/projects/${site.projectId}/materials`, headers: site.owner.auth });
    const cement = response.json().materials.find((m: { name: string }) => m.name === "Cement");
    expect(cement).toMatchObject({
      onHand: 20,
      usagePerUnit: 0.5,
      runOutDate: "2026-01-11",
      orderBy: "2026-01-06",
      status: "order_soon",
    });
  });

  it("raises one purchase request, asks the project manager, then asks suppliers for quotes", async () => {
    const site = await lowCementSite();
    const pm = await addLinkedUser(t, site.owner.auth, { name: "Sara", role: "project_manager", projectId: site.projectId });

    const supplier = (
      await t.app.inject({
        method: "POST",
        url: "/suppliers",
        headers: site.owner.auth,
        payload: { name: "Habesha Cement Agent", phone: "+251911000000", materials: ["Cement"] },
      })
    ).json().supplier as { userId: string };
    const code = (await t.app.inject({ method: "POST", url: `/users/${supplier.userId}/telegram-invite`, headers: site.owner.auth })).json().code;
    const supplierTelegram = 880_001;
    await deliver(t, textUpdate(supplierTelegram, `/start ${code}`));

    expect(await checkMaterials(t.runtime.deps, site.projectId)).toBe(1);
    expect(await checkMaterials(t.runtime.deps, site.projectId)).toBe(0);

    const [approval] = await t.handle.db.select().from(approvals).where(eq(approvals.projectId, site.projectId));
    expect(approval!.kind).toBe("purchase_request");
    expect(approval!.summary).toContain("runs out on Sun, 11 Jan 2026");
    expect(t.telegram.textsTo(pm.telegramId).at(-1)).toMatch(/^Order soon: \d+ bag of Cement/);

    const decided = await t.app.inject({
      method: "POST",
      url: `/approvals/${approval!.id}/decision`,
      headers: pm.auth!,
      payload: { decision: "approve" },
    });
    expect(decided.json().approval).toMatchObject({ status: "executed", result: { asked: 1 } });
    expect(t.telegram.textsTo(supplierTelegram).at(-1)).toMatch(
      /^Hello Habesha Cement Agent\. Abay Construction would like a price for \d+ bag of Cement, delivered to Bole, Addis Ababa by Sun, 11 Jan 2026\./,
    );
    const [request] = await t.handle.db.select().from(purchaseRequests).where(eq(purchaseRequests.projectId, site.projectId));
    expect(request!.status).toBe("approved");

    const listed = await t.app.inject({ url: `/projects/${site.projectId}/purchase-requests`, headers: site.owner.auth });
    expect(listed.json().purchaseRequests[0].material.name).toBe("Cement");
  });
});

describe("stock shortfall", () => {
  it("explains a shortfall instead of quoting negative stock", async () => {
    const site = await setupSiteProject(t);
    const cement = site.materials.cement;
    await t.handle.db.insert(materialTransactions).values([
      { materialId: cement.id, date: "2026-01-03", kind: "usage", quantity: 230, progress: 460, note: "More used than delivered" },
    ]);
    await recomputeStock(t.handle.db, [cement.id]);
    expect(await checkMaterials(t.runtime.deps, site.projectId)).toBe(1);
    const [approval] = await t.handle.db.select().from(approvals).where(eq(approvals.projectId, site.projectId));
    expect(approval!.summary).toMatch(/^Cement: none left on site by the records \(30 bag more used than delivered, so check for an unreported delivery\)/);
    expect(approval!.summary).toContain("so it should be ordered now");
    expect(approval!.summary).not.toMatch(/-\d+ bag on site/);
  });
});

describe("material routes", () => {
  it("adds materials with opening stock, refuses duplicates and records adjustments", async () => {
    const site = await setupSiteProject(t);
    const created = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/materials`,
      headers: site.owner.auth,
      payload: { name: "Rebar 12mm", unit: "bar", consumedBy: ["concrete_pour"], openingStock: 400, lastUnitPrice: 950 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().material.onHand).toBe(400);
    const id = created.json().material.id;

    const duplicate = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/materials`,
      headers: site.owner.auth,
      payload: { name: "rebar 12MM", unit: "bar" },
    });
    expect(duplicate.statusCode).toBe(409);

    const adjusted = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/materials/${id}/adjust`,
      headers: site.owner.auth,
      payload: { quantity: -12, note: "Physical count on Saturday" },
    });
    expect(adjusted.json().material.onHand).toBe(388);
    const history = await t.app.inject({ url: `/projects/${site.projectId}/materials/${id}/transactions`, headers: site.owner.auth });
    expect(history.json().transactions.map((tx: { quantity: number }) => tx.quantity).sort()).toEqual([-12, 400]);
  });
});
