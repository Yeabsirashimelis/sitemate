import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, dailyLogs, projects } from "../src/db/schema.js";
import { frameBuilding } from "../src/seed/demo-project.js";
import { seedDemo } from "../src/seed/seed.js";
import { validateImport } from "../src/domain/schedule-import.js";
import { createTestApp, type TestApp } from "./helpers/app.js";

describe("demo schedule generator", () => {
  it("builds a valid frame building schedule", () => {
    const activities = frameBuilding({ floors: 4, slabArea: 420, prefix: "B", blockName: "Block A" });
    expect(activities).toHaveLength(59);
    expect(() => validateImport(activities)).not.toThrow();
    expect(activities.at(-1)).toMatchObject({ code: "B5310", kind: "milestone", duration: 0 });
  });
});

describe("demo seed", () => {
  let t: TestApp;
  let result: Awaited<ReturnType<typeof seedDemo>>;

  beforeAll(async () => {
    t = await createTestApp();
    result = await seedDemo(t.handle.db, { today: "2026-11-12", password: "demo pass 123", reset: false, indexDocuments: false });
  }, 120_000);
  afterAll(async () => {
    await t.close();
  });

  it("creates two projects with weeks of applied history", async () => {
    expect(result.summary.map((s) => s.project)).toEqual(["Bole G+4 Apartments", "Kazanchis Commercial Building"]);
    const rows = await t.handle.db.select().from(projects).where(eq(projects.companyId, result.companyId));
    expect(rows.every((p) => p.dataDate === "2026-11-12")).toBe(true);
    for (const project of rows) {
      const logs = await t.handle.db.select().from(dailyLogs).where(eq(dailyLogs.projectId, project.id));
      expect(logs.length).toBeGreaterThan(15);
      expect(logs.every((l) => l.status === "complete")).toBe(true);
    }
  });

  it("is usable through the API with the demo logins", async () => {
    const login = await t.app.inject({ method: "POST", url: "/auth/login", payload: { email: "pm@abay.demo", password: "demo pass 123" } });
    expect(login.statusCode).toBe(200);
    const auth = { authorization: `Bearer ${login.json().token}` };
    const portfolio = (await t.app.inject({ url: "/portfolio", headers: auth })).json().projects;
    expect(portfolio).toHaveLength(2);
    for (const card of portfolio) {
      expect(card.forecastFinish).toBeTypeOf("string");
      expect(card.earnedValue).toBeGreaterThan(0);
      expect(card.spi).toBeGreaterThan(0);
    }
    const bole = portfolio.find((p: { name: string }) => p.name === "Bole G+4 Apartments");
    const lookahead = (await t.app.inject({ url: `/projects/${bole.id}/lookahead`, headers: auth })).json();
    expect(lookahead.items.length).toBeGreaterThan(0);
    const measures = (await t.app.inject({ url: `/projects/${bole.id}/recovery-measures`, headers: auth })).json().measures;
    expect(measures.length).toBe(5);
  });

  it("refuses to seed twice unless reset", async () => {
    await expect(seedDemo(t.handle.db, { today: "2026-11-12", password: "x", reset: false, indexDocuments: false })).rejects.toThrow(/already exists/);
    const again = await seedDemo(t.handle.db, { today: "2026-11-12", password: "demo pass 123", reset: true, indexDocuments: false });
    const remaining = await t.handle.db.select().from(companies).where(eq(companies.name, "Abay Construction PLC"));
    expect(remaining.map((c) => c.id)).toEqual([again.companyId]);
  }, 120_000);
});
