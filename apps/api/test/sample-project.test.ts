import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dailyLogs, materials, suppliers } from "../src/db/schema.js";
import { SAMPLE_PROJECT_NAME } from "../src/seed/sample.js";
import { createTestApp, registerCompany, type TestApp } from "./helpers/app.js";

describe("sample project for a new company", () => {
  let t: TestApp;
  const now = new Date("2026-11-12T09:00:00Z");

  beforeAll(async () => {
    t = await createTestApp({}, { now: () => now });
  });
  afterAll(async () => {
    await t.close();
  });

  it("gives a fresh sign-up a project with history it can explore", async () => {
    const owner = await registerCompany(t.app, "Tana Builders");
    expect((await t.app.inject({ method: "GET", url: "/projects", headers: owner.auth })).json().projects).toHaveLength(0);

    const created = await t.app.inject({ method: "POST", url: "/projects/sample", headers: owner.auth });
    expect(created.statusCode).toBe(201);
    const { projectId } = created.json() as { projectId: string };

    const list = (await t.app.inject({ method: "GET", url: "/projects", headers: owner.auth })).json().projects as Array<{ id: string; name: string }>;
    expect(list.map((p) => p.name)).toEqual([SAMPLE_PROJECT_NAME]);

    const schedule = (await t.app.inject({ method: "GET", url: `/projects/${projectId}/schedule`, headers: owner.auth })).json();
    expect(schedule.schedule.activities.length).toBeGreaterThan(30);
    expect((await t.handle.db.select().from(dailyLogs).where(eq(dailyLogs.projectId, projectId))).length).toBeGreaterThan(20);
    expect(await t.handle.db.select().from(materials).where(eq(materials.projectId, projectId))).toHaveLength(5);
    expect(await t.handle.db.select().from(suppliers).where(eq(suppliers.companyId, owner.company.id))).toHaveLength(4);

    // Once is enough.
    expect((await t.app.inject({ method: "POST", url: "/projects/sample", headers: owner.auth })).statusCode).toBe(409);
  });

  it("keeps each company's sample to itself", async () => {
    const first = await registerCompany(t.app, "First Builders");
    const second = await registerCompany(t.app, "Second Builders");
    const { projectId } = (await t.app.inject({ method: "POST", url: "/projects/sample", headers: first.auth })).json() as { projectId: string };
    expect((await t.app.inject({ method: "GET", url: "/projects", headers: second.auth })).json().projects).toHaveLength(0);
    expect((await t.app.inject({ method: "GET", url: `/projects/${projectId}/schedule`, headers: second.auth })).statusCode).toBe(404);
  });
});

describe("suppliers", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it("keeps one entry per supplier name in a company", async () => {
    const owner = await registerCompany(t.app, "Tana Builders");
    const add = (name: string) => t.app.inject({ method: "POST", url: "/suppliers", headers: owner.auth, payload: { name, materials: ["Cement"] } });
    expect((await add("Habesha Cement Agent")).statusCode).toBe(201);
    const again = await add("habesha cement agent");
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe("habesha cement agent is already on your supplier list");
  });
});
