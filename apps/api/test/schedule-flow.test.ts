import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activities, approvals, dailyLogs, recoveryMeasures } from "../src/db/schema.js";
import { handleReportedDelays } from "../src/features/schedule.js";
import { latestSnapshot } from "../src/services/schedule.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { addLinkedUser, deliver, setupSiteProject } from "./helpers/fixtures.js";
import { callbackUpdate, textUpdate } from "./helpers/telegram.js";

const clock = new Date("2026-01-08T14:30:00Z");
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ SITE_BATCH_SECONDS: "0" }, { now: () => clock });
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  t.llm.reset();
  t.telegram.reset();
});

const SITE = "site agent of SiteMate";
const SCHEDULE = "schedule agent of SiteMate";

function siteReport(issues: unknown[]) {
  return {
    summary: "Excavation finished.",
    weather: null,
    workers: [{ trade: "Labourer", count: 10 }],
    progress: [{ activityCode: "A10", percentComplete: 100, quantityDone: null, note: null }],
    materialsReceived: [],
    materialsUsed: [],
    issues,
    photoChecks: [],
    missing: [],
    followUpQuestion: null,
    confidence: 0.9,
  };
}

async function setup() {
  const site = await setupSiteProject(t);
  const pm = await addLinkedUser(t, site.owner.auth, { name: "Sara Tadesse", role: "project_manager", projectId: site.projectId });
  const add = (payload: Record<string, unknown>) =>
    t.app.inject({ method: "POST", url: `/projects/${site.projectId}/recovery-measures`, headers: site.owner.auth, payload });
  await add({ activityCode: "A40", description: "Second steel fixing crew on the columns", change: { kind: "shorten", days: 2 }, cost: 20_000, risk: "low" });
  await add({
    activityCode: "A40",
    description: "Start columns two days into the foundations",
    change: { kind: "relink", fromActivityCode: "A20", type: "SS", lag: 2 },
    cost: 3_000,
    risk: "medium",
  });
  await add({ activityCode: "A60", description: "Weekend shift on the slab", change: { kind: "shorten", days: 1 }, cost: 5_000, risk: "low" });
  t.telegram.reset();
  return { site, pm };
}

describe("recovery measures and what-if", () => {
  it("validates measures against the schedule", async () => {
    const { site } = await setup();
    const tooLong = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/recovery-measures`,
      headers: site.owner.auth,
      payload: { activityCode: "A60", description: "Impossible", change: { kind: "shorten", days: 2 }, cost: 1, risk: "low" },
    });
    expect(tooLong.statusCode).toBe(400);
    const noLink = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/recovery-measures`,
      headers: site.owner.auth,
      payload: {
        activityCode: "A60",
        description: "Overlap with drainage",
        change: { kind: "relink", fromActivityCode: "A30", type: "SS", lag: 0 },
        cost: 1,
        risk: "low",
      },
    });
    expect(noLink.json().error.message).toMatch(/A60 does not depend on A30/);

    const list = await t.app.inject({ url: `/projects/${site.projectId}/recovery-measures`, headers: site.owner.auth });
    expect(list.json().measures).toHaveLength(3);
  });

  it("answers what-if questions without saving anything", async () => {
    const { site } = await setup();
    const response = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/what-if`,
      headers: site.owner.auth,
      payload: { activityCode: "A40", days: 3 },
    });
    const result = response.json().result;
    expect(result).toMatchObject({ slipDays: 3, floatBefore: 0, finishBefore: "2026-01-18", finishAfter: "2026-01-21" });
    expect(result.recovery.plan).toMatchObject({ totalCost: 8_000, daysRecovered: 3, remainingSlip: 0, finishDate: "2026-01-18" });
    expect(result.recovery.options.map((o: { description: string }) => o.description)).toEqual([
      "Start columns two days into the foundations",
      "Weekend shift on the slab",
      "Second steel fixing crew on the columns",
    ]);
    const [a40] = await t.handle.db
      .select()
      .from(activities)
      .where(and(eq(activities.projectId, site.projectId), eq(activities.code, "A40")));
    expect(a40!.duration).toBe(5);
  });
});

describe("delays reported on site", () => {
  it("records the delay, prices a recovery plan and applies it when the project manager approves", async () => {
    const { site, pm } = await setup();
    t.llm.when(SITE, siteReport([{ kind: "delay", description: "Rebar delivery did not come", activityCode: "A40", severity: "high", delayDays: 3 }]));
    t.llm.when(SCHEDULE, (request: { parts: Array<{ text?: string }> }) => {
      const input = JSON.parse(request.parts[0]!.text!) as { plan: Array<{ measureId: string }> };
      return {
        explanation: "The rebar did not arrive, so the columns start three days late and the slab follows them.",
        optionNotes: input.plan.map((p) => ({ measureId: p.measureId, note: "Checked with the site engineer." })),
      };
    });

    const before = (await latestSnapshot(t.handle.db, site.projectId))!;
    await deliver(t, textUpdate(site.supervisor.telegramId, "Excavation done. Rebar did not come, columns 3 days late."));

    const [a40] = await t.handle.db
      .select()
      .from(activities)
      .where(and(eq(activities.projectId, site.projectId), eq(activities.code, "A40")));
    expect(a40!.duration).toBe(8);

    const [approval] = await t.handle.db.select().from(approvals).where(eq(approvals.projectId, site.projectId));
    expect(approval).toMatchObject({ kind: "recovery_plan", status: "pending", approverRole: "project_manager" });
    expect(approval!.title).toBe("Recovery plan: A40 Ground floor columns delay");
    expect(approval!.summary).toMatch(/^The rebar did not arrive/);
    expect(approval!.summary).toMatch(/Total 8,000 birr\. Recovers 3 of 3 days/);

    const message = t.telegram.sent.find((m) => m.chatId === pm.telegramId && m.text.startsWith("Recovery plan"))!;
    expect(message.text).toContain("- Start columns two days into the foundations: recovers 2 days, 3,000 birr, medium risk. Checked with the site engineer.");
    const delayed = (await latestSnapshot(t.handle.db, site.projectId))!;
    expect(delayed.finishDate > before.finishDate).toBe(true);

    await deliver(t, callbackUpdate(pm.telegramId, `ap:${approval!.id}:approve`, message.messageId));
    const recovered = (await latestSnapshot(t.handle.db, site.projectId))!;
    expect(recovered.reason).toMatch(/^Recovery plan applied/);
    expect(recovered.finishDate < delayed.finishDate).toBe(true);
    const applied = await t.handle.db.select().from(recoveryMeasures).where(eq(recoveryMeasures.projectId, site.projectId));
    expect(applied.filter((m) => m.appliedAt !== null)).toHaveLength(2);
  });

  it("tells the project manager when a delay is absorbed by float", async () => {
    const { site, pm } = await setup();
    t.llm.when(SITE, siteReport([{ kind: "delay", description: "Drainage pipes short", activityCode: "A30", severity: "medium", delayDays: 2 }]));
    await deliver(t, textUpdate(site.supervisor.telegramId, "Drainage pipes short, 2 days."));

    const texts = t.telegram.textsTo(pm.telegramId);
    expect(texts.at(-1)).toMatch(/^A30 Site drainage lost 2 workdays \(Drainage pipes short\)\. It had \d+ days of float/);
    const pending = await t.handle.db.select().from(approvals).where(eq(approvals.projectId, site.projectId));
    expect(pending).toHaveLength(0);
  });

  it("never counts the same delay twice", async () => {
    const { site } = await setup();
    t.llm.when(SITE, siteReport([{ kind: "delay", description: "Rebar late", activityCode: "A40", severity: "high", delayDays: 3 }]));
    t.llm.when(SCHEDULE, { explanation: "Rebar late.", optionNotes: [] });
    await deliver(t, textUpdate(site.supervisor.telegramId, "Rebar late 3 days"));

    const [log] = await t.handle.db.select().from(dailyLogs).where(eq(dailyLogs.projectId, site.projectId));
    const again = await handleReportedDelays(t.runtime.deps, log!.id);
    expect(again.impacts).toEqual([]);
    const [a40] = await t.handle.db
      .select()
      .from(activities)
      .where(and(eq(activities.projectId, site.projectId), eq(activities.code, "A40")));
    expect(a40!.duration).toBe(8);
  });

  it("still asks for approval with a plain explanation when the model is unavailable", async () => {
    const { site } = await setup();
    t.llm.when(SITE, siteReport([{ kind: "delay", description: "Rebar late", activityCode: "A40", severity: "high", delayDays: 3 }]));
    // No answer registered for the schedule agent, so its call fails.
    await deliver(t, textUpdate(site.supervisor.telegramId, "Rebar late 3 days"));
    const [approval] = await t.handle.db.select().from(approvals).where(eq(approvals.projectId, site.projectId));
    expect(approval!.summary).toMatch(/^A40 Ground floor columns is 3 workdays late \(Rebar late\)\. It is on the critical path/);
  });
});
