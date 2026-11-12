import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activities, materialTransactions, projects, rfis, weatherForecasts } from "../src/db/schema.js";
import { runWeeklyPlanning } from "../src/features/planning.js";
import { recomputeStock } from "../src/services/daily-logs.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { addLinkedUser, setupSiteProject } from "./helpers/fixtures.js";

let now = new Date("2026-01-05T06:00:00Z");
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({}, { now: () => now });
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  now = new Date("2026-01-05T06:00:00Z");
  t.telegram.reset();
});

type Item = { code: string; readiness: string; constraints: Array<{ kind: string; description: string; severity: string }> };

describe("three week look ahead", () => {
  it("flags missing material, open questions, weather and unfinished predecessors", async () => {
    const site = await setupSiteProject(t);
    const cement = site.materials.cement;
    await t.handle.db
      .insert(materialTransactions)
      .values({ materialId: cement.id, date: "2026-01-02", kind: "usage", quantity: 180, progress: 360, note: "Earlier work" });
    await recomputeStock(t.handle.db, [cement.id]);

    const [a40] = await t.handle.db
      .select()
      .from(activities)
      .where(and(eq(activities.projectId, site.projectId), eq(activities.code, "A40")));
    await t.handle.db.insert(rfis).values({
      projectId: site.projectId,
      number: 1,
      question: "Column C4 rebar schedule conflicts with the drawing",
      activityId: a40!.id,
      status: "sent",
      raisedOn: "2026-01-05",
      dueOn: "2026-01-08",
    });
    await t.handle.db.insert(weatherForecasts).values({ projectId: site.projectId, date: "2026-01-09", precipitationMm: 12, precipitationProbability: 90, windKmh: 10 });

    const response = await t.app.inject({ url: `/projects/${site.projectId}/lookahead`, headers: site.owner.auth });
    const items = response.json().items as Item[];
    const byCode = new Map(items.map((i) => [i.code, i]));

    expect(byCode.get("A10")!.readiness).toBe("ready");
    expect(byCode.get("A30")!.constraints).toEqual([
      { kind: "predecessor", description: "Waiting for A10 Excavation, forecast to finish Wed, 7 Jan 2026", severity: "warning" },
    ]);
    expect(byCode.get("A40")).toMatchObject({ readiness: "blocked" });
    expect(byCode.get("A40")!.constraints.map((c) => c.kind)).toContain("information");
    expect(byCode.get("A50")!.constraints).toContainEqual({
      kind: "material",
      description: "Cement runs out Sun, 11 Jan 2026, nothing ordered yet",
      severity: "blocking",
    });
    expect(byCode.get("A20")!.constraints).toContainEqual({
      kind: "weather",
      description: "12.0 mm of rain (90% chance) forecast on Fri, 9 Jan 2026",
      severity: "warning",
    });
  });
});

describe("weekly planning", () => {
  it("commits the week's work, scores it the next week and reports to the project manager", async () => {
    const site = await setupSiteProject(t);
    const pm = await addLinkedUser(t, site.owner.auth, { name: "Sara", role: "project_manager", projectId: site.projectId });

    const first = await runWeeklyPlanning(t.runtime.deps, site.projectId, "2026-01-05");
    expect(first.committed.sort()).toEqual(["A10", "A20", "A30"]);

    // A10 and A30 finished, A20 did not.
    for (const code of ["A10", "A30"]) {
      await t.handle.db
        .update(activities)
        .set({ actualStart: "2026-01-05", actualFinish: "2026-01-09", percentComplete: 100 })
        .where(and(eq(activities.projectId, site.projectId), eq(activities.code, code)));
    }
    await t.handle.db.update(projects).set({ dataDate: "2026-01-12" }).where(eq(projects.id, site.projectId));
    t.telegram.reset();
    await runWeeklyPlanning(t.runtime.deps, site.projectId, "2026-01-12");

    expect(t.telegram.textsTo(pm.telegramId).at(-1)).toContain("Last week 66.7% of the plan was completed.");
    const plans = (await t.app.inject({ url: `/projects/${site.projectId}/lookahead`, headers: site.owner.auth })).json().plans;
    expect(plans[0]).toMatchObject({ weekStart: "2026-01-05", percentPlanComplete: 66.7, completed: ["A10", "A30"] });
  });

  it("queues planning on Saturdays only", async () => {
    await setupSiteProject(t);
    now = new Date("2026-01-09T06:00:00Z"); // Friday
    expect((await t.runtime.scheduler.tick()).hooks["planning.weekly"]).toBe(0);
    now = new Date("2026-01-10T06:00:00Z"); // Saturday
    expect((await t.runtime.scheduler.tick()).hooks["planning.weekly"]).toBeGreaterThan(0);
  });
});
