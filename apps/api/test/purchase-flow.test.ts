import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purchaseRequests } from "../src/db/schema.js";
import { checkMaterials } from "../src/features/procurement.js";
import { createTestApp, registerCompany, type TestApp } from "./helpers/app.js";

interface Row {
  id: string;
  status: string;
  material: { name: string };
  suppliersAsked: number | null;
  quotes: Array<{ supplierName: string; unitPriceEtb: number }>;
  approval: { id: string; step: "quotes" | "order"; title: string } | null;
}

describe("buying from suppliers who are not on Telegram", () => {
  let t: TestApp;
  const now = new Date("2026-11-12T09:00:00Z");

  beforeAll(async () => {
    t = await createTestApp({}, { now: () => now });
  });
  afterAll(async () => {
    await t.close();
  });

  async function sampleWithRequests() {
    const owner = await registerCompany(t.app, "Tana Builders");
    const { projectId } = (await t.app.inject({ method: "POST", url: "/projects/sample", headers: owner.auth })).json() as { projectId: string };
    expect(await checkMaterials(t.runtime.deps, projectId)).toBeGreaterThan(0);
    const list = async () =>
      ((await t.app.inject({ method: "GET", url: `/projects/${projectId}/purchase-requests`, headers: owner.auth })).json() as { purchaseRequests: Row[] }).purchaseRequests;
    return { owner, projectId, list };
  }

  it("goes from request to order with a price taken by phone", async () => {
    const { owner, list } = await sampleWithRequests();
    const [first] = await list();
    expect(first!.status).toBe("pending_approval");
    expect(first!.approval).toMatchObject({ step: "quotes" });

    // Approve asking for prices. No supplier is linked, so nobody can be asked.
    await t.app.inject({ method: "POST", url: `/approvals/${first!.approval!.id}/decision`, headers: owner.auth, payload: { decision: "approve" } });
    let row = (await list()).find((r) => r.id === first!.id)!;
    expect(row).toMatchObject({ status: "approved", suppliersAsked: 0, approval: null });

    // The project manager phones a supplier and records the price.
    const suppliers = (await t.app.inject({ method: "GET", url: "/suppliers", headers: owner.auth })).json().suppliers as Array<{ id: string; name: string; materials: string[] }>;
    const supplier = suppliers.find((s) => s.materials.includes(first!.material.name))!;
    const recorded = await t.app.inject({
      method: "POST",
      url: `/purchase-requests/${first!.id}/quotes`,
      headers: owner.auth,
      payload: { supplierId: supplier.id, unitPrice: 1800, leadTimeDays: 1, note: "Delivered to site" },
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json()).toEqual({ proposed: true });

    row = (await list()).find((r) => r.id === first!.id)!;
    expect(row.quotes).toEqual([expect.objectContaining({ supplierName: supplier.name, unitPriceEtb: 1800 })]);
    expect(row.approval).toMatchObject({ step: "order" });
    expect(row.approval!.title).toContain(supplier.name);

    await t.app.inject({ method: "POST", url: `/approvals/${row.approval!.id}/decision`, headers: owner.auth, payload: { decision: "approve" } });
    expect((await list()).find((r) => r.id === first!.id)!.status).toBe("ordered");

    // Ordered requests take no more prices.
    const late = await t.app.inject({ method: "POST", url: `/purchase-requests/${first!.id}/quotes`, headers: owner.auth, payload: { supplierId: supplier.id, unitPrice: 1700, leadTimeDays: 1 } });
    expect(late.statusCode).toBe(409);
  });

  it("cancels the request when the manager says not now, so it can be raised again later", async () => {
    const { owner, projectId, list } = await sampleWithRequests();
    const [first] = await list();
    await t.app.inject({ method: "POST", url: `/approvals/${first!.approval!.id}/decision`, headers: owner.auth, payload: { decision: "reject", note: "Not needed now" } });
    const [stored] = await t.handle.db.select().from(purchaseRequests).where(eq(purchaseRequests.id, first!.id));
    expect(stored!.status).toBe("cancelled");
    // With the old one closed, the next stock check raises a fresh request.
    expect(await checkMaterials(t.runtime.deps, projectId)).toBeGreaterThan(0);
  });

  it("keeps other companies out", async () => {
    const { list } = await sampleWithRequests();
    const [first] = await list();
    const stranger = await registerCompany(t.app, "Other Builders");
    const response = await t.app.inject({
      method: "POST",
      url: `/purchase-requests/${first!.id}/quotes`,
      headers: stranger.auth,
      payload: { supplierId: "00000000-0000-4000-8000-000000000000", unitPrice: 1, leadTimeDays: 1 },
    });
    expect(response.statusCode).toBe(404);
  });
});
