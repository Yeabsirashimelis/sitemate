import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activities } from "../src/db/schema.js";
import { createTestApp, registerCompany, type TestApp } from "./helpers/app.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ AUTH_RATE_LIMIT_PER_MINUTE: "1000" });
});
afterAll(async () => {
  await t.close();
});

const SCHEDULE_CSV = [
  "code,name,duration,predecessors,kind,zone",
  "A10,Excavation,3,,excavation,Block A",
  "A20,Foundations,4,A10,concrete_pour,Block A",
  "A30,Site drainage,2,A10,general,External",
  "A40,Ground floor columns,5,A20,concrete_pour,Block A",
  "A50,Boundary wall,3,A30,masonry,External",
  "A60,Ground floor slab,2,A40;A50,concrete_pour,Block A",
].join("\n");

async function createProject(auth: Record<string, string>, overrides: Record<string, unknown> = {}) {
  const response = await t.app.inject({
    method: "POST",
    url: "/projects",
    headers: auth,
    payload: {
      name: "Bole G+4 Apartments",
      client: "Mr. Tesfaye Alemu",
      consultant: "Addis Design Consult",
      locationName: "Bole, Addis Ababa",
      latitude: 8.9956,
      longitude: 38.7869,
      // A Monday, every day worked, so dates are easy to check.
      startDate: "2026-01-05",
      contractFinish: "2026-01-18",
      calendar: { workingWeekdays: [0, 1, 2, 3, 4, 5, 6], holidays: [] },
      ...overrides,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().project as { id: string; calendar: { holidays: string[] } };
}

describe("projects", () => {
  it("creates a project with the Ethiopian holiday calendar by default", async () => {
    const { auth } = await registerCompany(t.app);
    const project = await createProject(auth, { startDate: "2026-09-01", contractFinish: "2027-06-30", calendar: undefined });
    expect(project.calendar.holidays).toContain("2026-09-27");
    expect(project.calendar.holidays).toContain("2027-01-07");

    const list = await t.app.inject({ url: "/projects", headers: auth });
    expect(list.json().projects).toHaveLength(1);
  });

  it("rejects a contract finish before the start", async () => {
    const { auth } = await registerCompany(t.app);
    const response = await t.app.inject({
      method: "POST",
      url: "/projects",
      headers: auth,
      payload: { name: "Wrong dates", startDate: "2026-05-01", contractFinish: "2026-04-01" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("imports a CSV schedule, sets the baseline and returns the critical path", async () => {
    const { auth } = await registerCompany(t.app);
    const project = await createProject(auth);

    const imported = await t.app.inject({
      method: "PUT",
      url: `/projects/${project.id}/schedule`,
      headers: { ...auth, "content-type": "text/csv" },
      payload: SCHEDULE_CSV,
    });
    expect(imported.statusCode).toBe(200);
    const schedule = imported.json().schedule;
    expect(schedule.finishDate).toBe("2026-01-18");
    expect(schedule.slipDays).toBe(0);
    expect(schedule.criticalPath).toEqual(["A10", "A20", "A40", "A60"]);
    const drainage = schedule.activities.find((a: { code: string }) => a.code === "A30");
    expect(drainage).toMatchObject({ totalFloat: 4, critical: false, baselineStart: 3, baselineFinish: 5 });

    const fetched = await t.app.inject({ url: `/projects/${project.id}/schedule`, headers: auth });
    expect(fetched.json().schedule.criticalPath).toEqual(["A10", "A20", "A40", "A60"]);
  });

  it("imports JSON and reports loops in the logic without saving anything", async () => {
    const { auth } = await registerCompany(t.app);
    const project = await createProject(auth);
    const response = await t.app.inject({
      method: "PUT",
      url: `/projects/${project.id}/schedule`,
      headers: auth,
      payload: {
        activities: [
          { code: "X1", name: "One", duration: 2, predecessors: [{ code: "X2" }] },
          { code: "X2", name: "Two", duration: 2, predecessors: [{ code: "X1" }] },
        ],
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.join(" ")).toMatch(/loop/);
    const saved = await t.handle.db.select().from(activities).where(eq(activities.projectId, project.id));
    expect(saved).toHaveLength(0);
  });

  it("refuses to overwrite a schedule with progress unless forced", async () => {
    const { auth } = await registerCompany(t.app);
    const project = await createProject(auth);
    const put = (query = "") =>
      t.app.inject({
        method: "PUT",
        url: `/projects/${project.id}/schedule${query}`,
        headers: { ...auth, "content-type": "text/csv" },
        payload: SCHEDULE_CSV,
      });
    await put();
    await t.handle.db
      .update(activities)
      .set({ actualStart: "2026-01-05" })
      .where(eq(activities.projectId, project.id));

    expect((await put()).statusCode).toBe(409);
    expect((await put("?force=true")).statusCode).toBe(200);
  });

  it("hides other companies' projects and limits engineers to their own projects", async () => {
    const a = await registerCompany(t.app, "Company A");
    const b = await registerCompany(t.app, "Company B");
    const project = await createProject(a.auth);

    expect((await t.app.inject({ url: `/projects/${project.id}`, headers: b.auth })).statusCode).toBe(404);

    const email = `eng${Date.now()}@example.com`;
    const engineer = await t.app.inject({
      method: "POST",
      url: "/users",
      headers: a.auth,
      payload: { name: "Dawit", role: "site_engineer", email, password: "engineer pass 1" },
    });
    const login = await t.app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "engineer pass 1" } });
    const engAuth = { authorization: `Bearer ${login.json().token}` };

    expect((await t.app.inject({ url: `/projects/${project.id}`, headers: engAuth })).statusCode).toBe(404);
    expect((await t.app.inject({ url: "/projects", headers: engAuth })).json().projects).toHaveLength(0);

    await t.app.inject({
      method: "PUT",
      url: `/projects/${project.id}/members/${engineer.json().user.id}`,
      headers: a.auth,
    });
    const visible = await t.app.inject({ url: `/projects/${project.id}`, headers: engAuth });
    expect(visible.statusCode).toBe(200);
    expect(visible.json().members.map((m: { name: string }) => m.name)).toContain("Dawit");

    const engImport = await t.app.inject({
      method: "PUT",
      url: `/projects/${project.id}/schedule`,
      headers: { ...engAuth, "content-type": "text/csv" },
      payload: SCHEDULE_CSV,
    });
    expect(engImport.statusCode).toBe(403);
  });
});
