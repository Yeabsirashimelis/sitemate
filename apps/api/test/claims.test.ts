import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isClaimable } from "../src/agents/claims-agent.js";
import { approvals, claimEvents, dailyLogs, paymentClaims, rfis } from "../src/db/schema.js";
import { recordDelayForClaims } from "../src/features/claims.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { addLinkedUser, deliver, setupSiteProject } from "./helpers/fixtures.js";
import { photoUpdate, textUpdate } from "./helpers/telegram.js";

const CONTRACT = `14.3 Extension of Time for Completion
The Contractor is entitled to an extension of time if completion is delayed by any delay caused by the Employer, including late payment, or by late drawings or instructions from the Engineer.
The Contractor shall give notice of a claim to the Engineer not later than 28 days after becoming aware of the event.
`;

describe("isClaimable", () => {
  it("allows time for the client's and consultant's delays and for exceptional weather", () => {
    expect(isClaimable({ cause: "late_payment", responsible: "client" })).toBe(true);
    expect(isClaimable({ cause: "late_information", responsible: "consultant" })).toBe(true);
    expect(isClaimable({ cause: "weather", responsible: "neutral" })).toBe(true);
    expect(isClaimable({ cause: "supplier", responsible: "contractor" })).toBe(false);
    expect(isClaimable({ cause: "other", responsible: "neutral" })).toBe(false);
  });
});

describe("claims file", () => {
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
    t.telegram.reset();
  });

  const siteReport = (description: string) => ({
    summary: description,
    weather: null,
    workers: [],
    progress: [{ activityCode: "A10", percentComplete: 100, quantityDone: null, note: null }],
    materialsReceived: [],
    materialsUsed: [],
    issues: [{ kind: "delay", description, activityCode: "A40", severity: "high", delayDays: 3 }],
    photoChecks: [{ description: "Empty rebar yard", matchesReport: true, concern: null }],
    missing: [],
    followUpQuestion: null,
    confidence: 0.9,
  });

  function classifyAs(cause: string, responsible: string) {
    t.llm.when("classify the cause of a delay", {
      cause,
      responsible,
      title: "Steel delivery held because the client has not paid",
      reasoning: "The supplier refused to deliver because the client's advance payment is late.",
    });
  }

  function noticeWriter() {
    t.llm.when("draft a notice of delay", (request: { parts: Array<{ text?: string }> }) => ({
      subject: "Notice of delay to ground floor columns",
      body: `We give notice of a delay under the Contract. ${/Clause 14\.3/.test(request.parts[0]!.text!) ? "We rely on clause 14.3." : ""}`,
    }));
  }

  async function projectWithContract() {
    const site = await setupSiteProject(t);
    const pm = await addLinkedUser(t, site.owner.auth, { name: "Sara", role: "project_manager", projectId: site.projectId });
    await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/documents`,
      headers: site.owner.auth,
      payload: { title: "Conditions of Contract", kind: "contract", fileName: "contract.txt", mimeType: "text/plain", contentBase64: Buffer.from(CONTRACT).toString("base64") },
    });
    await t.runtime.runner.drain();
    t.telegram.reset();
    return { site, pm };
  }

  it("opens an evidence file for a delay the client caused and drafts the notice", async () => {
    const { site, pm } = await projectWithContract();
    t.llm.when("site agent of SiteMate", siteReport("Steel supplier will not deliver until the client pays the advance"));
    classifyAs("late_payment", "client");
    noticeWriter();
    t.telegram.files.set("yard", { data: Buffer.from("jpg"), path: "p.jpg" });

    await deliver(t, photoUpdate(site.supervisor.telegramId, "yard", "No steel today"));

    const [event] = await t.handle.db.select().from(claimEvents).where(eq(claimEvents.projectId, site.projectId));
    expect(event).toMatchObject({ cause: "late_payment", responsible: "client", status: "open", delayDays: 3, clauseRefs: ["14.3"] });
    expect(event!.evidence.map((e) => e.type)).toEqual(["daily_log", "schedule", "photo"]);
    expect(event!.noticeDraft).toBe("Subject: Notice of delay to ground floor columns\n\nWe give notice of a delay under the Contract. We rely on clause 14.3.");

    const notice = (await t.handle.db.select().from(approvals).where(eq(approvals.projectId, site.projectId))).find((a) => a.kind === "delay_notice")!;
    expect(notice.summary).toContain("The contract notice period ends Thu, 5 Feb 2026 (clause 14.3).");
    const decided = await t.app.inject({ method: "POST", url: `/approvals/${notice.id}/decision`, headers: pm.auth!, payload: { decision: "approve" } });
    expect(decided.json().approval.status).toBe("executed");
    const listed = await t.app.inject({ url: `/projects/${site.projectId}/claims`, headers: pm.auth! });
    expect(listed.json()).toMatchObject({ events: [{ status: "notified" }], totals: { claimableDays: 3 } });
  });

  it("keeps the contractor's own delays out of the claims file, and never opens an event twice", async () => {
    const { site } = await projectWithContract();
    t.llm.when("site agent of SiteMate", siteReport("Our steel supplier's truck broke down"));
    classifyAs("supplier", "contractor");
    await deliver(t, textUpdate(site.supervisor.telegramId, "Our steel supplier's truck broke down, 3 days"));
    expect(await t.handle.db.select().from(claimEvents).where(eq(claimEvents.projectId, site.projectId))).toHaveLength(0);

    classifyAs("late_payment", "client");
    noticeWriter();
    const [log] = await t.handle.db.select().from(dailyLogs).where(eq(dailyLogs.projectId, site.projectId));
    const delay = { projectId: site.projectId, dailyLogId: log!.id, activityCode: "A40", days: 3, slipDays: 3, description: "Held for payment", logDate: "2026-01-08" };
    const first = await recordDelayForClaims(t.runtime.deps, delay);
    const second = await recordDelayForClaims(t.runtime.deps, delay);
    expect(second!.id).toBe(first!.id);
  });

  it("sends RFIs after approval and turns a late answer into a claim measured against float", async () => {
    const { site, pm } = await projectWithContract();
    noticeWriter();
    const created = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/rfis`,
      headers: pm.auth!,
      payload: { question: "Please confirm the column C4 reinforcement, the schedule and the drawing differ.", activityCode: "A40", dueInDays: 3 },
    });
    expect(created.json().rfi).toMatchObject({ number: 1, status: "pending_approval", dueOn: "2026-01-08" });
    const approval = (await t.handle.db.select().from(approvals).where(eq(approvals.projectId, site.projectId))).find((a) => a.kind === "consultant_rfi")!;
    await t.app.inject({ method: "POST", url: `/approvals/${approval.id}/decision`, headers: pm.auth!, payload: { decision: "approve" } });
    const [sent] = await t.handle.db.select().from(rfis).where(eq(rfis.projectId, site.projectId));
    expect(sent!.status).toBe("sent");

    const answered = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/rfis/${sent!.id}/answer`,
      headers: pm.auth!,
      payload: { answer: "Use the drawing.", answeredOn: "2026-01-12" },
    });
    // Four workdays late on a critical activity: four workdays on completion.
    expect(answered.json().claimEvent).toMatchObject({ cause: "late_information", responsible: "consultant", delayDays: 4 });
  });

  it("reminds about overdue RFIs once a day and opens a claim for late payment", async () => {
    const { site, pm } = await projectWithContract();
    noticeWriter();
    await t.handle.db.insert(rfis).values({
      projectId: site.projectId,
      number: 7,
      question: "Confirm the slab thickness",
      status: "sent",
      raisedOn: "2026-01-02",
      dueOn: "2026-01-06",
    });
    await t.handle.db.insert(paymentClaims).values({
      projectId: site.projectId,
      number: 1,
      periodEnd: "2025-12-01",
      status: "submitted",
      cumulativeGross: 500_000,
      previousGross: 0,
      retention: 25_000,
      netThisPeriod: 475_000,
      lines: [],
    });

    await t.runtime.scheduler.tick();
    await t.runtime.scheduler.tick();
    const reminders = t.telegram.textsTo(pm.telegramId).filter((m) => m.startsWith("RFI 7"));
    expect(reminders).toEqual([
      'RFI 7 to the consultant was due Tue, 6 Jan 2026 and is 2 workdays late: "Confirm the slab thickness". The waiting time is being recorded for the claims file.',
    ]);
    const events = await t.handle.db.select().from(claimEvents).where(eq(claimEvents.projectId, site.projectId));
    expect(events.map((e) => e.title)).toEqual(["Late payment of interim payment claim 1"]);
  });
});
