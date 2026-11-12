import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvals, dailyLogs, rfis } from "../src/db/schema.js";
import { draftRfisFromLog } from "../src/features/rfis.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { addLinkedUser, deliver, setupSiteProject } from "./helpers/fixtures.js";
import { textUpdate } from "./helpers/telegram.js";

describe("requests for information", () => {
  let t: TestApp;
  const now = new Date("2026-01-07T09:00:00Z");

  beforeAll(async () => {
    t = await createTestApp({}, { now: () => now });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => t.telegram.reset());

  async function logWaitingForDrawing(projectId: string, supervisorId: string) {
    const [log] = await t.handle.db
      .insert(dailyLogs)
      .values({
        projectId,
        supervisorId,
        logDate: "2026-01-07",
        status: "complete",
        issues: [
          { kind: "information", description: "Cannot start the foundations, the revised structural drawing has not come from the consultant", activityCode: "A20", severity: "high" },
          { kind: "weather", description: "Rain for two hours", severity: "low" },
        ],
      })
      .returning();
    return log!;
  }

  it("drafts an RFI from site, blocks the activity, sends it on approval and records the consultant's reply", async () => {
    const site = await setupSiteProject(t);
    const consultant = await addLinkedUser(t, site.owner.auth, { name: "Addis Design Consult", role: "consultant", projectId: site.projectId });
    const log = await logWaitingForDrawing(site.projectId, site.supervisor.id);

    expect(await draftRfisFromLog(t.runtime.deps, log.id)).toBe(1);
    // The supervisor will mention it again tomorrow; that must not open a second RFI.
    expect(await draftRfisFromLog(t.runtime.deps, log.id)).toBe(0);

    const [rfi] = await t.handle.db.select().from(rfis).where(eq(rfis.projectId, site.projectId));
    expect(rfi).toMatchObject({ number: 1, status: "pending_approval", raisedOn: "2026-01-05", dueOn: "2026-01-10" });
    expect(rfi!.question).toMatch(/revised structural drawing.*Please provide/);

    // Until it is answered, the work it holds up is blocked in the look-ahead.
    const lookahead = (await t.app.inject({ method: "GET", url: `/projects/${site.projectId}/lookahead`, headers: site.owner.auth })).json();
    const a20 = lookahead.items.find((i: { code: string }) => i.code === "A20");
    expect(a20.readiness).toBe("blocked");
    expect(a20.constraints.map((c: { description: string }) => c.description).join(" ")).toContain("Waiting for an answer to RFI 1");

    const [approval] = await t.handle.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.projectId, site.projectId), eq(approvals.kind, "consultant_rfi")));
    const decided = await t.app.inject({ method: "POST", url: `/approvals/${approval!.id}/decision`, headers: site.owner.auth, payload: { decision: "approve" } });
    expect(decided.json().approval.status).toBe("executed");
    const sent = t.telegram.textsTo(consultant.telegramId).at(-1)!;
    expect(sent).toContain("Request for information 1, Bole G+4 Apartments");
    expect(sent).toContain("Work affected: A20 Foundations");
    expect(sent).toContain('starting with "RFI 1"');

    await deliver(t, textUpdate(consultant.telegramId, "RFI 1: use drawing S-04 revision B, sent by email today."));
    const [answered] = await t.handle.db.select().from(rfis).where(eq(rfis.id, rfi!.id));
    expect(answered).toMatchObject({ status: "answered", answer: "use drawing S-04 revision B, sent by email today.", answeredOn: "2026-01-07" });
    expect(t.telegram.textsTo(consultant.telegramId).at(-1)).toContain("Your answer to RFI 1 is recorded");
  });

  it("asks the consultant which RFI an answer is for when several are open", async () => {
    const site = await setupSiteProject(t);
    const consultant = await addLinkedUser(t, site.owner.auth, { name: "Consultant", role: "consultant", projectId: site.projectId });
    for (const question of ["Which rebar grade for the columns?", "Confirm the slab thickness on grid C."]) {
      await t.app.inject({ method: "POST", url: `/projects/${site.projectId}/rfis`, headers: site.owner.auth, payload: { question } });
    }
    const pending = await t.handle.db.select().from(approvals).where(and(eq(approvals.projectId, site.projectId), eq(approvals.kind, "consultant_rfi")));
    for (const a of pending) await t.app.inject({ method: "POST", url: `/approvals/${a.id}/decision`, headers: site.owner.auth, payload: { decision: "approve" } });

    await deliver(t, textUpdate(consultant.telegramId, "B500 for all columns."));
    expect(t.telegram.textsTo(consultant.telegramId).at(-1)).toMatch(/Which request is this answer for\?[\s\S]*RFI 1[\s\S]*RFI 2/);
    expect((await t.handle.db.select().from(rfis).where(eq(rfis.projectId, site.projectId))).every((r) => r.status === "sent")).toBe(true);
  });

  it("gives the letter for consultants who are not on Telegram", async () => {
    const site = await setupSiteProject(t);
    const created = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/rfis`,
      headers: site.owner.auth,
      payload: { question: "Please confirm the concrete grade for the ground floor slab.", activityCode: "A60" },
    });
    const { rfi } = created.json() as { rfi: { id: string } };
    const letter = (await t.app.inject({ method: "GET", url: `/projects/${site.projectId}/rfis/${rfi.id}/letter`, headers: site.owner.auth })).json();
    expect(letter.subject).toBe("RFI 1, Bole G+4 Apartments");
    expect(letter.letter).toContain("Work affected: A60 Ground floor slab");
    expect(letter.letter).toContain("Please confirm the concrete grade for the ground floor slab.");
  });
});
