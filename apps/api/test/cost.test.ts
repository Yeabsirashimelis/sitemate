import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvals, costEntries, paymentClaims } from "../src/db/schema.js";
import { parseBoqCsv } from "../src/domain/boq-import.js";
import { ImportError } from "../src/domain/schedule-import.js";
import { nearMonthEnd } from "../src/features/cost.js";
import { labourCost } from "../src/services/cost.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { addLinkedUser, deliver, setupSiteProject } from "./helpers/fixtures.js";
import { textUpdate } from "./helpers/telegram.js";

const BOQ = [
  "Item No,Description,Unit,Qty,Unit Rate,Activity",
  "1.1,Preliminaries and site setup,LS,1,50000,",
  '2.1,"Excavation to foundation level, any depth",m3,120,350,A10',
  '3.1,"C25 concrete in foundations, including formwork",m3,40,"9,800",A20',
  "3.2,C25 concrete in ground floor columns,m3,18,11000,A40",
  "3.3,C25 concrete in ground floor slab,m3,35,9800,A60",
].join("\n");

describe("cost helpers", () => {
  it("prices labour by trade with a default rate", () => {
    const rates = { Mason: 900, labourer: 450, default: 400 };
    expect(
      labourCost(
        [
          { trade: "Masons", count: 8 },
          { trade: "Labourer", count: 12 },
          { trade: "Carpenter", count: 2 },
        ],
        rates,
      ),
    ).toBe(13_400);
    expect(labourCost([{ trade: "Welder", count: 3 }], { mason: 900 })).toBe(0);
  });

  it("knows when the month is ending", () => {
    expect(nearMonthEnd("2026-01-28")).toBe(false);
    expect(nearMonthEnd("2026-01-29")).toBe(true);
    expect(nearMonthEnd("2026-02-26")).toBe(true);
    expect(nearMonthEnd("2026-02-25")).toBe(false);
  });

  it("reads a bill of quantities with quoted text and thousands separators", () => {
    const items = parseBoqCsv(BOQ);
    expect(items).toHaveLength(5);
    expect(items[2]).toEqual({
      itemNo: "3.1",
      description: "C25 concrete in foundations, including formwork",
      unit: "m3",
      quantity: 40,
      rate: 9800,
      activityCode: "A20",
    });
    expect(items[0]!.activityCode).toBeUndefined();
    expect(() => parseBoqCsv("item_no,description,unit,quantity,rate\n1,A,m,x,2\n1,B,m,1,2")).toThrow(ImportError);
  });
});

describe("cost control", () => {
  let t: TestApp;
  let now = new Date("2026-01-08T14:30:00Z");
  beforeAll(async () => {
    t = await createTestApp({ SITE_BATCH_SECONDS: "0" }, { now: () => now });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => {
    now = new Date("2026-01-08T14:30:00Z");
    t.llm.reset();
  });

  async function projectWithProgress() {
    const site = await setupSiteProject(t);
    const pm = await addLinkedUser(t, site.owner.auth, { name: "Sara", role: "project_manager", projectId: site.projectId });
    await t.app.inject({
      method: "PUT",
      url: `/projects/${site.projectId}/labour-rates`,
      headers: site.owner.auth,
      payload: { mason: 900, labourer: 450, default: 400 },
    });
    const boq = await t.app.inject({
      method: "PUT",
      url: `/projects/${site.projectId}/boq`,
      headers: { ...site.owner.auth, "content-type": "text/csv" },
      payload: BOQ,
    });
    expect(boq.json()).toEqual({ items: 5, contractValue: 50_000 + 42_000 + 392_000 + 198_000 + 343_000 });

    t.llm.when("site agent of SiteMate", {
      summary: "Excavation done, foundations half poured.",
      weather: null,
      workers: [
        { trade: "Mason", count: 8 },
        { trade: "Labourer", count: 12 },
      ],
      progress: [
        { activityCode: "A10", percentComplete: 100, quantityDone: 120, note: null },
        { activityCode: "A20", percentComplete: 50, quantityDone: 20, note: null },
      ],
      materialsReceived: [],
      materialsUsed: [],
      issues: [],
      photoChecks: [],
      missing: [],
      followUpQuestion: null,
      confidence: 0.9,
    });
    await deliver(t, textUpdate(site.supervisor.telegramId, "Excavation done, foundations half poured. 8 masons 12 labourers."));
    return { site, pm };
  }

  it("rejects BOQ items that point to unknown activities", async () => {
    const site = await setupSiteProject(t);
    const response = await t.app.inject({
      method: "PUT",
      url: `/projects/${site.projectId}/boq`,
      headers: site.owner.auth,
      payload: { items: [{ itemNo: "9.9", description: "Lift", unit: "nr", quantity: 1, rate: 1, activityCode: "Z99" }] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details).toEqual(["Item 9.9: activity Z99 is not in the schedule"]);
  });

  it("books labour from the daily log once, and reports earned value", async () => {
    const { site } = await projectWithProgress();
    const labour = await t.handle.db.select().from(costEntries).where(eq(costEntries.projectId, site.projectId));
    expect(labour).toEqual([expect.objectContaining({ category: "labour", amount: 12_600, date: "2026-01-08" })]);

    const cost = (await t.app.inject({ url: `/projects/${site.projectId}/cost`, headers: site.owner.auth })).json();
    // Planned by 9 January: all of the excavation and one of the four foundation days.
    expect(cost.summary).toMatchObject({
      budgetAtCompletion: 975_000,
      plannedValue: 140_000,
      earnedValue: 238_000,
      actualCost: 12_600,
      spi: 1.7,
    });
    expect(cost.costByCategory).toEqual({ labour: 12_600 });
    expect(cost.series.at(-1)).toMatchObject({ date: "2026-01-09", earnedValue: 238_000 });
  });

  it("drafts a payment claim from measured progress and submits it when approved", async () => {
    const { site, pm } = await projectWithProgress();
    const drafted = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/payment-claims`,
      headers: pm.auth!,
      payload: { periodEnd: "2026-01-31" },
    });
    expect(drafted.statusCode).toBe(201);
    const claim = drafted.json().claim;
    expect(claim).toMatchObject({ number: 1, status: "pending_approval", cumulativeGross: 238_000, retention: 11_900, netThisPeriod: 226_100 });
    const foundations = claim.lines.find((l: { itemNo: string }) => l.itemNo === "3.1");
    expect(foundations).toMatchObject({ cumulativeQuantity: 20, previousQuantity: 0, thisPeriodAmount: 196_000 });
    expect(foundations.evidence).toHaveLength(1);

    const again = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/payment-claims`,
      headers: pm.auth!,
      payload: { periodEnd: "2026-01-31" },
    });
    expect(again.statusCode).toBe(409);

    const [approval] = await t.handle.db.select().from(approvals).where(eq(approvals.projectId, site.projectId));
    expect(approval!.title).toBe("Interim payment claim 1 up to Sat, 31 Jan 2026");
    await t.app.inject({ method: "POST", url: `/approvals/${approval!.id}/decision`, headers: pm.auth!, payload: { decision: "approve" } });
    const [submitted] = await t.handle.db.select().from(paymentClaims).where(eq(paymentClaims.id, claim.id));
    expect(submitted!.status).toBe("submitted");

    const csv = await t.app.inject({ url: `/projects/${site.projectId}/payment-claims/${claim.id}/csv`, headers: pm.auth! });
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body).toContain('3.1,"C25 concrete in foundations, including formwork",m3,9800,40,0,20,196000');
    expect(csv.body).toContain("Net amount due this period,,,,,,226100");
  });

  it("drafts the claim on its own near month end, once", async () => {
    const { site } = await projectWithProgress();
    now = new Date("2026-01-30T06:00:00Z");
    const first = await t.runtime.scheduler.tick();
    expect(first.hooks["cost.monthly-claim"]).toBeGreaterThanOrEqual(1);
    const claims = await t.handle.db.select().from(paymentClaims).where(eq(paymentClaims.projectId, site.projectId));
    expect(claims).toHaveLength(1);
    await t.runtime.scheduler.tick();
    expect(await t.handle.db.select().from(paymentClaims).where(eq(paymentClaims.projectId, site.projectId))).toHaveLength(1);
  });
});
