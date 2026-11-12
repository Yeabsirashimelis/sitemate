import { t as say } from "../src/i18n.js";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmError } from "../src/ai/llm.js";
import { activities, dailyLogs, materials, materialTransactions, projects, scheduleSnapshots } from "../src/db/schema.js";
import { queueDueCheckIns } from "../src/features/site.js";
import { JobRunner } from "../src/jobs/queue.js";
import { receiveUpdate, TELEGRAM_UPDATE_JOB } from "../src/telegram/bot.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { deliver, setupSiteProject } from "./helpers/fixtures.js";
import { lastPrompt } from "./helpers/llm.js";
import { photoUpdate, textUpdate, voiceUpdate } from "./helpers/telegram.js";

// 14:30 UTC is 17:30 in Addis Ababa.
let clock = new Date("2026-01-08T14:30:00Z");
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ SITE_BATCH_SECONDS: "0" }, { now: () => clock });
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  clock = new Date("2026-01-08T14:30:00Z");
  t.llm.reset();
  t.telegram.reset();
});

const SITE = "site agent of SiteMate";

const fullDay = {
  summary: "Excavation finished and foundations half done. Blocks delivered.",
  weather: "Sunny",
  workers: [
    { trade: "Mason", count: 8 },
    { trade: "Labourer", count: 12 },
  ],
  progress: [
    { activityCode: "A10", percentComplete: 100, quantityDone: 40, note: null },
    { activityCode: "A20", percentComplete: 50, quantityDone: 20, note: null },
  ],
  materialsReceived: [{ material: "HCB blocks", quantity: 500, unit: "pcs" }],
  materialsUsed: [{ material: "cement", quantity: 30, unit: "bag" }],
  issues: [],
  photoChecks: [],
  missing: [],
  followUpQuestion: null,
  confidence: 0.92,
};

async function logFor(projectId: string) {
  const [log] = await t.handle.db.select().from(dailyLogs).where(eq(dailyLogs.projectId, projectId));
  return log!;
}

async function activity(projectId: string, code: string) {
  const [row] = await t.handle.db
    .select()
    .from(activities)
    .where(and(eq(activities.projectId, projectId), eq(activities.code, code)));
  return row!;
}

describe("daily site loop", () => {
  it("turns a supervisor's report into a log and updates the schedule and stock", async () => {
    const site = await setupSiteProject(t);
    t.llm.when(SITE, fullDay);
    t.telegram.reset();

    await deliver(t, textUpdate(site.supervisor.telegramId, "Excavation done, foundations about half. 8 masons 12 labourers. Used 30 bags cement, 500 blocks arrived."));

    const log = await logFor(site.projectId);
    expect(log).toMatchObject({ status: "complete", logDate: "2026-01-08", confidence: 0.92 });
    expect(log.workers).toEqual([
      { trade: "Mason", count: 8 },
      { trade: "Labourer", count: 12 },
    ]);

    expect(await activity(site.projectId, "A10")).toMatchObject({
      percentComplete: 100,
      actualStart: "2026-01-08",
      actualFinish: "2026-01-08",
      remainingDuration: 0,
    });
    expect(await activity(site.projectId, "A20")).toMatchObject({ percentComplete: 50, actualStart: "2026-01-08", remainingDuration: 2 });

    const [cement] = await t.handle.db.select().from(materials).where(eq(materials.id, site.materials.cement.id));
    const [blocks] = await t.handle.db.select().from(materials).where(eq(materials.id, site.materials.blocks.id));
    expect(cement!.onHand).toBe(170);
    expect(blocks!.onHand).toBe(1500);

    const [project] = await t.handle.db.select().from(projects).where(eq(projects.id, site.projectId));
    expect(project!.dataDate).toBe("2026-01-09");
    const [snapshot] = await t.handle.db
      .select()
      .from(scheduleSnapshots)
      .where(eq(scheduleSnapshots.projectId, site.projectId))
      .orderBy(desc(scheduleSnapshots.createdAt))
      .limit(1);
    expect(snapshot!.reason).toBe("Daily log 2026-01-08 from Abebe Kebede");

    expect(t.telegram.textsTo(site.supervisor.telegramId).at(-1)).toMatch(/^Thank you\. Today's log is saved\./);
    expect(lastPrompt(t.llm)).toMatch(/A20 \| Foundations \| Block A \| unit m3 \| now 0%/);
    expect(lastPrompt(t.llm)).toMatch(/Text: Excavation done/);
  });

  it("asks a follow-up question in the supervisor's language, then completes with the answer", async () => {
    const site = await setupSiteProject(t, { language: "am" });
    let calls = 0;
    t.llm.when(SITE, () => {
      calls++;
      return calls === 1
        ? { ...fullDay, workers: [], followUpQuestion: "ዛሬ ስንት ግንበኞች ነበሩ?", missing: ["workers"] }
        : fullDay;
    });
    t.telegram.reset();

    await deliver(t, textUpdate(site.supervisor.telegramId, "ቁፋሮው ተጠናቋል"));
    // First the instant acknowledgement, then the question once the report has been read.
    expect(t.telegram.textsTo(site.supervisor.telegramId)).toEqual([say("reading", "am"), "ዛሬ ስንት ግንበኞች ነበሩ?"]);
    expect(await logFor(site.projectId)).toMatchObject({ status: "awaiting_answer", followUpsAsked: 1 });
    expect(t.llm.requests[0]!.system).toMatch(/followUpQuestion in Amharic/);

    await deliver(t, textUpdate(site.supervisor.telegramId, "8 ግንበኞች"));
    expect(lastPrompt(t.llm)).toMatch(/Earlier today you asked: "ዛሬ ስንት ግንበኞች ነበሩ\?"/);
    expect(await logFor(site.projectId)).toMatchObject({ status: "complete" });
    expect(t.telegram.textsTo(site.supervisor.telegramId).at(-1)).toBe("አመሰግናለሁ። የዛሬው ሪፖርት ተመዝግቧል።");
  });

  it("stops asking after two follow-ups and saves what it has", async () => {
    const site = await setupSiteProject(t);
    t.llm.when(SITE, { ...fullDay, followUpQuestion: "How many workers?" });
    t.telegram.reset();
    for (const text of ["first", "second", "third"]) await deliver(t, textUpdate(site.supervisor.telegramId, text));
    const sent = t.telegram.textsTo(site.supervisor.telegramId);
    expect(sent.filter((m) => m === "How many workers?")).toHaveLength(2);
    expect(sent.at(-1)).toMatch(/log is saved/);
  });

  it("reads a burst of messages together, sending photos and voice notes to the model", async () => {
    const site = await setupSiteProject(t);
    t.llm.when(SITE, fullDay);
    t.telegram.files.set("slab-photo", { data: Buffer.from("jpeg bytes"), path: "photos/1.jpg" });
    t.telegram.files.set("voice-note", { data: Buffer.from("ogg bytes"), path: "voice/1.oga" });

    // Store three updates and let only the Telegram intake run, the way they
    // would arrive within the batching window.
    const updates = [
      textUpdate(site.supervisor.telegramId, "Today's update"),
      photoUpdate(site.supervisor.telegramId, "slab-photo", "Foundations"),
      voiceUpdate(site.supervisor.telegramId, "voice-note"),
    ];
    for (const update of updates) await receiveUpdate(t.handle.db, update);
    const intakeOnly = new JobRunner(t.handle.db, t.runtime.logger).register(TELEGRAM_UPDATE_JOB, {
      schema: z.object({ updateId: z.number() }),
      handle: ({ updateId }) => t.runtime.bot!.processStoredUpdate(updateId),
    });
    await intakeOnly.drain();
    await t.runtime.runner.drain();

    expect(t.llm.requests).toHaveLength(1);
    const media = t.llm.requests[0]!.parts.flatMap((p) => ("inlineData" in p ? [p.inlineData.mimeType] : []));
    expect(media).toEqual(["image/jpeg", "audio/ogg"]);
    expect(lastPrompt(t.llm)).toMatch(/Photo with caption: Foundations:/);
  });

  it("re-processes a log when more comes in later, without counting materials twice", async () => {
    const site = await setupSiteProject(t);
    t.llm.when(SITE, fullDay);
    await deliver(t, textUpdate(site.supervisor.telegramId, "Used 30 bags cement"));

    t.llm.when(SITE, { ...fullDay, materialsUsed: [{ material: "Cement", quantity: 40, unit: "bag" }] });
    clock = new Date("2026-01-08T16:00:00Z");
    await deliver(t, textUpdate(site.supervisor.telegramId, "Sorry, it was 40 bags in total"));

    const [cement] = await t.handle.db.select().from(materials).where(eq(materials.id, site.materials.cement.id));
    expect(cement!.onHand).toBe(160);
    const log = await logFor(site.projectId);
    const movements = await t.handle.db.select().from(materialTransactions).where(eq(materialTransactions.dailyLogId, log.id));
    expect(movements.map((m) => [m.kind, m.quantity]).sort()).toEqual([
      ["delivery", 500],
      ["usage", 40],
    ]);
  });

  it("tells the supervisor once when the update cannot be processed", async () => {
    const site = await setupSiteProject(t);
    t.llm.respond(() => {
      throw new LlmError("Model output did not match the schema", false);
    });
    t.telegram.reset();
    await deliver(t, textUpdate(site.supervisor.telegramId, "update"));
    const sent = t.telegram.textsTo(site.supervisor.telegramId);
    expect(sent).toEqual([say("reading", "en"), "Thank you. I could not process your update automatically, so I have passed it to your project manager."]);
  });
});

describe("evening check-in", () => {
  let c: TestApp;
  let now = new Date("2026-01-08T12:00:00Z");
  beforeAll(async () => {
    c = await createTestApp({ SITE_BATCH_SECONDS: "0" }, { now: () => now });
  });
  afterAll(async () => {
    await c.close();
  });

  it("asks each supervisor once after the project's check-in time, unless they already reported", async () => {
    const site = await setupSiteProject(c);
    c.telegram.reset();

    now = new Date("2026-01-08T12:00:00Z"); // 15:00 local, before 17:00
    expect(await queueDueCheckIns(c.runtime.deps)).toBe(0);

    now = new Date("2026-01-08T14:05:00Z"); // 17:05 local
    expect(await queueDueCheckIns(c.runtime.deps)).toBe(1);
    expect(await queueDueCheckIns(c.runtime.deps)).toBe(0);
    await c.runtime.runner.drain();
    expect(c.telegram.textsTo(site.supervisor.telegramId)).toEqual([
      "Good evening Abebe. Please send today's update for Bole G+4 Apartments: what work was done, how many workers by trade, materials received or used, any problems, and a few photos. A voice note is fine.",
    ]);

    // Next day the supervisor reports before the check-in time.
    c.llm.when(SITE, fullDay);
    now = new Date("2026-01-09T10:00:00Z");
    await deliver(c, textUpdate(site.supervisor.telegramId, "Report"));
    c.telegram.reset();
    now = new Date("2026-01-09T14:30:00Z");
    await queueDueCheckIns(c.runtime.deps);
    await c.runtime.runner.drain();
    expect(c.telegram.textsTo(site.supervisor.telegramId)).toEqual([]);
  });
});
