import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { decide } from "../src/approvals/policy.js";
import { approvals, auditLog } from "../src/db/schema.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { addLinkedUser, deliver, setupSiteProject } from "./helpers/fixtures.js";
import { callbackUpdate } from "./helpers/telegram.js";

const policy = { ownerApprovalThresholdEtb: 200_000 };

describe("policy", () => {
  it("lets agents remind and notify on their own", () => {
    expect(decide({ kind: "reminder", type: "x" }, policy)).toEqual({ mode: "auto" });
    expect(decide({ kind: "notification", type: "x" }, policy)).toEqual({ mode: "auto" });
  });

  it("sends plan changes and outside messages to the project manager", () => {
    for (const kind of ["schedule_change", "recovery_plan", "supplier_message", "consultant_rfi", "delay_notice", "client_report"] as const) {
      expect(decide({ kind, type: "x" }, policy)).toEqual({ mode: "approval", approverRole: "project_manager" });
    }
  });

  it("sends large purchases and expensive recovery plans to the owner", () => {
    expect(decide({ kind: "purchase_request", type: "x", amountEtb: 150_000 }, policy)).toMatchObject({ approverRole: "project_manager" });
    expect(decide({ kind: "purchase_request", type: "x", amountEtb: 250_000 }, policy)).toMatchObject({ approverRole: "owner" });
    expect(decide({ kind: "recovery_plan", type: "x", amountEtb: 300_000 }, policy)).toMatchObject({ approverRole: "owner" });
  });
});

describe("approval service", () => {
  let t: TestApp;
  const ran: Array<{ value: number; by: string | null }> = [];

  beforeAll(async () => {
    t = await createTestApp();
    t.runtime.deps.approvals
      .register("test.record", z.object({ value: z.number() }), async (action, context) => {
        ran.push({ value: action.value, by: context.decidedBy?.id ?? null });
        return { stored: action.value };
      })
      .register("test.explode", z.object({}), async () => {
        throw new Error("Supplier phone number is unreachable");
      });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => {
    ran.length = 0;
    t.telegram.reset();
  });

  async function setup() {
    const site = await setupSiteProject(t);
    const pm = await addLinkedUser(t, site.owner.auth, { name: "Sara Tadesse", role: "project_manager", projectId: site.projectId });
    const engineer = await addLinkedUser(t, site.owner.auth, { name: "Dawit", role: "site_engineer", projectId: site.projectId });
    t.telegram.reset();
    return { site, pm, engineer };
  }

  const propose = (companyId: string, projectId: string, extra: Partial<Parameters<typeof t.runtime.deps.approvals.propose>[0]> = {}) =>
    t.runtime.deps.approvals.propose({
      companyId,
      projectId,
      kind: "schedule_change",
      title: "Move the ground floor slab pour to Friday",
      summary: "Heavy rain is forecast on Thursday.",
      action: { type: "test.record", value: 7 },
      evidence: [{ label: "Open-Meteo forecast: 18 mm on Thursday" }],
      requestedBy: "weather",
      ...extra,
    });

  it("runs automatic actions straight away and records them", async () => {
    const { site } = await setup();
    const result = await propose(site.owner.company.id, site.projectId, { kind: "reminder" });
    expect(result).toEqual({ mode: "auto", result: { stored: 7 } });
    expect(ran).toEqual([{ value: 7, by: null }]);
    const logged = await t.handle.db.select().from(auditLog).where(eq(auditLog.action, "action.test.record"));
    expect(logged.length).toBeGreaterThan(0);
  });

  it("asks the project manager on Telegram and runs the action when approved there", async () => {
    const { site, pm } = await setup();
    const result = await propose(site.owner.company.id, site.projectId);
    expect(result.mode).toBe("approval");
    expect(ran).toEqual([]);

    const message = t.telegram.sent.find((m) => m.chatId === pm.telegramId)!;
    expect(message.text).toContain("Move the ground floor slab pour to Friday");
    expect(message.text).toContain("- Open-Meteo forecast: 18 mm on Thursday");
    const approve = message.options.buttons![0]![0]!;
    expect(approve.text).toBe("Approve");

    await deliver(t, callbackUpdate(pm.telegramId, approve.callback_data, message.messageId));
    expect(ran).toEqual([{ value: 7, by: pm.id }]);
    expect(t.telegram.answered.at(-1)?.text).toBe("Approved and done");
    expect(t.telegram.removedButtons).toContainEqual({ chatId: pm.telegramId, messageId: message.messageId });

    const [row] = await t.handle.db.select().from(approvals).where(eq(approvals.id, (result as { approval: { id: string } }).approval.id));
    expect(row).toMatchObject({ status: "executed", decidedBy: pm.id, result: { stored: 7 } });
  });

  it("does not run rejected actions and refuses a second decision", async () => {
    const { site, pm } = await setup();
    const { approval } = (await propose(site.owner.company.id, site.projectId)) as { approval: { id: string } };
    const reject = await t.app.inject({
      method: "POST",
      url: `/approvals/${approval.id}/decision`,
      headers: pm.auth!,
      payload: { decision: "reject", note: "We will pour on Thursday morning before the rain" },
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json().approval).toMatchObject({ status: "rejected", decisionNote: "We will pour on Thursday morning before the rain" });
    expect(ran).toEqual([]);

    const again = await t.app.inject({
      method: "POST",
      url: `/approvals/${approval.id}/decision`,
      headers: pm.auth!,
      payload: { decision: "approve" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("only lets the right role decide", async () => {
    const { site, pm, engineer } = await setup();
    const { approval } = (await propose(site.owner.company.id, site.projectId)) as { approval: { id: string } };
    const byEngineer = await t.app.inject({
      method: "POST",
      url: `/approvals/${approval.id}/decision`,
      headers: engineer.auth!,
      payload: { decision: "approve" },
    });
    expect(byEngineer.statusCode).toBe(403);

    const big = (await propose(site.owner.company.id, site.projectId, {
      kind: "purchase_request",
      amountEtb: 450_000,
      title: "Order 900 bags of cement",
    })) as { approval: { id: string; approverRole: string } };
    expect(big.approval.approverRole).toBe("owner");
    const byPm = await t.app.inject({
      method: "POST",
      url: `/approvals/${big.approval.id}/decision`,
      headers: pm.auth!,
      payload: { decision: "approve" },
    });
    expect(byPm.statusCode).toBe(403);
    const byOwner = await t.app.inject({
      method: "POST",
      url: `/approvals/${big.approval.id}/decision`,
      headers: site.owner.auth,
      payload: { decision: "approve" },
    });
    expect(byOwner.json().approval.status).toBe("executed");
  });

  it("records a failed action instead of losing it", async () => {
    const { site, pm } = await setup();
    const { approval } = (await propose(site.owner.company.id, site.projectId, {
      kind: "supplier_message",
      action: { type: "test.explode" },
    })) as { approval: { id: string } };
    const response = await t.app.inject({
      method: "POST",
      url: `/approvals/${approval.id}/decision`,
      headers: pm.auth!,
      payload: { decision: "approve" },
    });
    expect(response.json().approval).toMatchObject({ status: "failed", result: { error: "Supplier phone number is unreachable" } });
  });

  it("validates the action when it is proposed", async () => {
    const { site } = await setup();
    await expect(propose(site.owner.company.id, site.projectId, { action: { type: "test.record", value: "seven" } })).rejects.toThrow();
    await expect(propose(site.owner.company.id, site.projectId, { action: { type: "no.such.executor" } })).rejects.toThrow(/No executor/);
  });

  it("expires old requests", async () => {
    const { site, pm } = await setup();
    const { approval } = (await propose(site.owner.company.id, site.projectId, { expiresInHours: -1 })) as {
      approval: { id: string };
    };
    const response = await t.app.inject({
      method: "POST",
      url: `/approvals/${approval.id}/decision`,
      headers: pm.auth!,
      payload: { decision: "approve" },
    });
    expect(response.statusCode).toBe(400);
    expect(ran).toEqual([]);
  });

  it("lists pending requests for the dashboard and hides other companies' requests", async () => {
    const a = await setup();
    const b = await setup();
    const { approval } = (await propose(a.site.owner.company.id, a.site.projectId)) as { approval: { id: string } };

    const list = await t.app.inject({ url: "/approvals?status=pending", headers: a.pm.auth! });
    expect(list.json().approvals.map((x: { id: string }) => x.id)).toContain(approval.id);
    const other = await t.app.inject({ url: `/approvals/${approval.id}`, headers: b.pm.auth! });
    expect(other.statusCode).toBe(404);
  });
});
