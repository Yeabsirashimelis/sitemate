import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activities, materials } from "../src/db/schema.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { deliver, setupSiteProject } from "./helpers/fixtures.js";
import { photoUpdate, textUpdate } from "./helpers/telegram.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ SITE_BATCH_SECONDS: "0" }, { now: () => new Date("2026-01-08T14:30:00Z") });
  t.llm.when("site agent of SiteMate", {
    summary: "Excavation finished, 30 bags of cement used.",
    weather: null,
    workers: [{ trade: "Labourer", count: 10 }],
    progress: [{ activityCode: "A10", percentComplete: 100, quantityDone: null, note: null }],
    materialsReceived: [],
    materialsUsed: [{ material: "Cement", quantity: 30, unit: "bag" }],
    issues: [],
    photoChecks: [],
    missing: [],
    followUpQuestion: null,
    confidence: 0.85,
  });
});
afterAll(async () => {
  await t.close();
});

async function reportedSite() {
  const site = await setupSiteProject(t);
  t.telegram.files.set("pit", { data: Buffer.from("jpeg-bytes"), path: "photos/pit.jpg" });
  await deliver(t, textUpdate(site.supervisor.telegramId, "Excavation done, 30 bags cement"));
  await deliver(t, photoUpdate(site.supervisor.telegramId, "pit", "Excavation"));
  return site;
}

describe("dashboard data", () => {
  it("summarizes each project for the portfolio", async () => {
    const site = await reportedSite();
    const response = await t.app.inject({ url: "/portfolio", headers: site.owner.auth });
    expect(response.json().projects).toEqual([
      expect.objectContaining({
        id: site.projectId,
        name: "Bole G+4 Apartments",
        contractFinish: "2026-01-18",
        forecastFinish: expect.any(String),
        lastLogDate: "2026-01-08",
        pendingApprovals: 0,
      }),
    ]);
  });

  it("lists daily logs with the original messages and streams their photos", async () => {
    const site = await reportedSite();
    const logs = (await t.app.inject({ url: `/projects/${site.projectId}/daily-logs`, headers: site.owner.auth })).json().logs;
    expect(logs[0]).toMatchObject({ logDate: "2026-01-08", supervisorName: "Abebe Kebede", status: "complete" });
    const photo = logs[0].messages.find((m: { kind: string }) => m.kind === "photo");
    expect(photo).toMatchObject({ direction: "in", text: "Excavation" });

    const media = await t.app.inject({ url: `/projects/${site.projectId}/messages/${photo.id}/media`, headers: site.owner.auth });
    expect(media.statusCode).toBe(200);
    expect(media.headers["content-type"]).toBe("image/jpeg");
    expect(media.body).toBe("jpeg-bytes");

    const other = await setupSiteProject(t);
    const blocked = await t.app.inject({ url: `/projects/${site.projectId}/messages/${photo.id}/media`, headers: other.owner.auth });
    expect(blocked.statusCode).toBe(404);
  });

  it("lets a person correct a log, and progress and stock follow", async () => {
    const site = await reportedSite();
    const [log] = (await t.app.inject({ url: `/projects/${site.projectId}/daily-logs`, headers: site.owner.auth })).json().logs;
    const corrected = await t.app.inject({
      method: "PUT",
      url: `/projects/${site.projectId}/daily-logs/${log.id}`,
      headers: site.owner.auth,
      payload: {
        summary: "Excavation 80% done, 20 bags of cement used.",
        workers: [{ trade: "Labourer", count: 10 }],
        progress: [{ activityCode: "A10", percentComplete: 80 }],
        materialsReceived: [],
        materialsUsed: [{ material: "Cement", quantity: 20, unit: "bag" }],
        issues: [],
      },
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json().log.correctedBy).toBe(site.owner.user.id);

    const [a10] = await t.handle.db
      .select()
      .from(activities)
      .where(and(eq(activities.projectId, site.projectId), eq(activities.code, "A10")));
    expect(a10).toMatchObject({ percentComplete: 80, actualFinish: null });
    const [cement] = await t.handle.db.select().from(materials).where(eq(materials.id, site.materials.cement.id));
    expect(cement!.onHand).toBe(180);
  });

  it("shows what the agents did and what they cost", async () => {
    const site = await reportedSite();
    const activity = (await t.app.inject({ url: `/projects/${site.projectId}/activity`, headers: site.owner.auth })).json();
    expect(activity.entries.map((e: { action: string }) => e.action)).toContain("daily_log.applied");
    expect(activity.agents).toEqual(expect.arrayContaining([expect.objectContaining({ agent: "site", runs: 2, errors: 0, inputTokens: 200 })]));
  });
});
