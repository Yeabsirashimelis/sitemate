import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activities, boqItems } from "../src/db/schema.js";
import { buildingSchedule } from "../src/domain/building-template.js";
import { validateImport } from "../src/domain/schedule-import.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { setupSiteProject } from "./helpers/fixtures.js";

const base = { floors: 4, floorArea: 420, basement: false, roof: "steel", externalWorks: true, blockName: "Block A" } as const;

describe("building template", () => {
  it("builds a valid schedule with one set of frame activities per floor", () => {
    const list = buildingSchedule(base);
    expect(() => validateImport(list)).not.toThrow();
    for (const floor of [1, 2, 3, 4]) expect(list.some((a) => a.code === `B${2000 + floor * 100 + 30}`)).toBe(true);
    expect(list.some((a) => a.code === "B2530")).toBe(false);
  });

  it("adds the basement before the foundations and drops external works when asked", () => {
    const list = buildingSchedule({ ...base, basement: true, externalWorks: false });
    expect(() => validateImport(list)).not.toThrow();
    const byCode = new Map(list.map((a) => [a.code, a]));
    expect(byCode.get("B1010")!.predecessors.map((p) => p.code)).toEqual(["B1005"]);
    expect(byCode.has("B1056")).toBe(true);
    expect(byCode.has("B5200")).toBe(false);
    expect(byCode.get("B5300")!.predecessors.some((p) => p.code === "B5200")).toBe(false);
  });

  it("takes longer for bigger floors, but less than in proportion", () => {
    const total = (area: number) => buildingSchedule({ ...base, floorArea: area }).reduce((sum, a) => sum + a.duration, 0);
    expect(total(1200)).toBeGreaterThan(total(420));
    expect(total(1200)).toBeLessThan(total(420) * (1200 / 420));
  });
});

describe("schedule builder routes", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => t.llm.reset());

  it("reads a description, says what it assumed, and previews the programme", async () => {
    const site = await setupSiteProject(t);
    t.llm.when("pick out a few facts about the building", { floors: 5, floorArea: null, basement: true, roof: null, externalWorks: null, blockName: null });
    const response = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/schedule/draft`,
      headers: site.owner.auth,
      payload: { description: "G+5 mixed use building in Bole with one basement for parking" },
    });
    expect(response.statusCode).toBe(200);
    const draft = response.json();
    expect(draft.parameters).toMatchObject({ floors: 5, floorArea: 300, basement: true, roof: "steel" });
    expect(draft.assumptions).toHaveLength(2);
    expect(draft.summary).toContain("G+5");
    expect(draft.activities).toBe(draft.preview.length);
    expect(draft.finishDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(draft.estimatedCost).toBeGreaterThan(0);
  });

  it("drafts from numbers alone without calling the model", async () => {
    const site = await setupSiteProject(t);
    const response = await t.app.inject({ method: "POST", url: `/projects/${site.projectId}/schedule/draft`, headers: site.owner.auth, payload: { parameters: base } });
    expect(response.statusCode).toBe(200);
    expect(response.json().assumptions).toEqual([]);
    expect(t.llm.requests).toHaveLength(0);
  });

  it("asks for the numbers when the model cannot be reached", async () => {
    const site = await setupSiteProject(t);
    const response = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/schedule/draft`,
      headers: site.owner.auth,
      payload: { description: "A small G+2 house in Adama" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.message).toContain("numbers");
  });

  it("uses the schedule and adds a priced bill of quantities", async () => {
    const site = await setupSiteProject(t);
    const response = await t.app.inject({ method: "POST", url: `/projects/${site.projectId}/schedule/build`, headers: site.owner.auth, payload: { parameters: base } });
    expect(response.statusCode).toBe(200);
    const rows = await t.handle.db.select().from(activities).where(eq(activities.projectId, site.projectId));
    expect(rows).toHaveLength(buildingSchedule(base).length);
    const boq = await t.handle.db.select().from(boqItems).where(eq(boqItems.projectId, site.projectId));
    expect(boq.length).toBe(response.json().boqItems);
    expect(boq.filter((b) => b.activityId).length).toBe(boq.length - 1);

    // Built again, the bill already there is left alone.
    const again = await t.app.inject({ method: "POST", url: `/projects/${site.projectId}/schedule/build`, headers: site.owner.auth, payload: { parameters: { ...base, floors: 2 } } });
    expect(again.json().boqItems).toBe(0);
  });
});
