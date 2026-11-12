/**
 * Approvals: agents propose, people decide, and only then does the action run.
 *
 * Every action is a typed payload with a registered executor. The payload is
 * validated when proposed and again right before it runs, the decision and
 * the result are written to the audit log, and the Telegram buttons are
 * removed once someone has decided so nobody can approve twice.
 */

import { and, eq, inArray, lt } from "drizzle-orm";
import type { z } from "zod";
import { canApprove } from "../auth/permissions.js";
import type { User } from "../auth/sessions.js";
import { audit } from "../audit.js";
import type { Database, Executor } from "../db/client.js";
import { approvals, projectMembers, users, type ApprovalEvidence } from "../db/schema.js";
import { badRequest, conflict, forbidden, notFound } from "../http/errors.js";
import type { TelegramBot } from "../telegram/bot.js";
import { decide, type ActionKind, type ApprovalKind, type PolicyOptions } from "./policy.js";

export type Approval = typeof approvals.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExecutionContext {
  db: Database;
  approval: Pick<Approval, "id" | "companyId" | "projectId">;
  /** Who approved it, or null when it ran automatically. */
  decidedBy: User | null;
}

interface ExecutorDefinition {
  schema: z.ZodType;
  run: (action: unknown, context: ExecutionContext) => Promise<unknown>;
  /** Tidies up when a person says no, e.g. cancels the purchase request. */
  onReject?: ((action: unknown, context: ExecutionContext) => Promise<void>) | undefined;
}

export interface Proposal {
  companyId: string;
  projectId: string | null;
  kind: ActionKind;
  title: string;
  summary: string;
  /** Executor type plus its payload, validated against the executor's schema. */
  action: { type: string } & Record<string, unknown>;
  evidence?: ApprovalEvidence[];
  requestedBy: string;
  amountEtb?: number;
  /** Hours before an unanswered approval expires. */
  expiresInHours?: number;
}

export type ProposalResult =
  | { mode: "auto"; result: unknown }
  | { mode: "approval"; approval: Approval };

export class ApprovalService {
  private readonly executors = new Map<string, ExecutorDefinition>();

  constructor(
    private readonly db: Database,
    private readonly bot: TelegramBot | null,
    private readonly policy: PolicyOptions,
  ) {
    bot?.onCallback("ap", async ({ user, data, query }) => {
      const [approvalId = "", choice] = data.split(":");
      if (!UUID.test(approvalId) || (choice !== "approve" && choice !== "reject")) return "Unknown action";
      try {
        const decided = await this.decide(approvalId, user, choice === "approve" ? "approved" : "rejected");
        return decided.status === "executed" ? "Approved and done" : decided.status === "rejected" ? "Rejected" : "Approved, but it could not be carried out";
      } catch (error) {
        if (error instanceof Error && "statusCode" in error) return error.message;
        throw error;
      } finally {
        if (query.message) await bot.api.removeButtons(query.message.chat.id, query.message.message_id).catch(() => undefined);
      }
    });
  }

  register<S extends z.ZodType>(
    type: string,
    schema: S,
    run: (action: z.infer<S>, context: ExecutionContext) => Promise<unknown>,
    options: { onReject?: (action: z.infer<S>, context: ExecutionContext) => Promise<void> } = {},
  ): this {
    if (this.executors.has(type)) throw new Error(`Executor "${type}" is already registered`);
    this.executors.set(type, { schema, run: run as ExecutorDefinition["run"], onReject: options.onReject as ExecutorDefinition["onReject"] });
    return this;
  }

  private executor(type: string): ExecutorDefinition {
    const executor = this.executors.get(type);
    if (!executor) throw new Error(`No executor for action "${type}"`);
    return executor;
  }

  /** Runs the action now if the policy allows, otherwise asks the right people. */
  async propose(proposal: Proposal): Promise<ProposalResult> {
    const executor = this.executor(proposal.action.type);
    const action = { ...(executor.schema.parse(proposal.action) as object), type: proposal.action.type };
    const decision = decide(
      { kind: proposal.kind, type: proposal.action.type, ...(proposal.amountEtb !== undefined ? { amountEtb: proposal.amountEtb } : {}) },
      this.policy,
    );

    if (decision.mode === "auto") {
      const result = await executor.run(action, {
        db: this.db,
        approval: { id: "auto", companyId: proposal.companyId, projectId: proposal.projectId },
        decidedBy: null,
      });
      await audit(this.db, {
        companyId: proposal.companyId,
        projectId: proposal.projectId,
        actor: { type: "agent", id: proposal.requestedBy },
        action: `action.${proposal.action.type}`,
        reason: proposal.summary,
        data: { action, result },
      });
      return { mode: "auto", result };
    }

    const [approval] = await this.db
      .insert(approvals)
      .values({
        companyId: proposal.companyId,
        projectId: proposal.projectId,
        // Only approval kinds reach this point; the policy runs the others automatically.
        kind: proposal.kind as ApprovalKind,
        title: proposal.title,
        summary: proposal.summary,
        action,
        evidence: proposal.evidence ?? [],
        requestedBy: proposal.requestedBy,
        approverRole: decision.approverRole,
        expiresAt: new Date(Date.now() + (proposal.expiresInHours ?? 72) * 3_600_000),
      })
      .returning();
    await audit(this.db, {
      companyId: proposal.companyId,
      projectId: proposal.projectId,
      actor: { type: "agent", id: proposal.requestedBy },
      action: "approval.requested",
      subject: { type: "approval", id: approval!.id },
      reason: proposal.title,
    });
    await this.notifyApprovers(approval!);
    return { mode: "approval", approval: approval! };
  }

  /** People who may decide: the required role on the project, plus owners. */
  async approversFor(approval: Pick<Approval, "companyId" | "projectId" | "approverRole">): Promise<User[]> {
    const candidates = await this.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.companyId, approval.companyId),
          eq(users.active, true),
          inArray(users.role, approval.approverRole === "owner" ? ["owner"] : ["owner", approval.approverRole]),
        ),
      );
    if (!approval.projectId || approval.approverRole === "owner") return candidates;

    const members = new Set(
      (
        await this.db
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(eq(projectMembers.projectId, approval.projectId))
      ).map((m) => m.userId),
    );
    // Project managers on this project; owners only if no manager is assigned.
    const managers = candidates.filter((u) => u.role !== "owner" && members.has(u.id));
    return managers.length > 0 ? managers : candidates.filter((u) => u.role === "owner");
  }

  private async notifyApprovers(approval: Approval): Promise<void> {
    if (!this.bot) return;
    const text = [approval.title, "", approval.summary, ...evidenceLines(approval.evidence)].join("\n");
    const sent: Array<{ chatId: number; messageId: number }> = [];
    for (const approver of await this.approversFor(approval)) {
      const message = await this.bot.sendToUser(approver, text, {
        ...(approval.projectId ? { projectId: approval.projectId } : {}),
        buttons: [
          [
            { text: "Approve", callback_data: `ap:${approval.id}:approve` },
            { text: "Reject", callback_data: `ap:${approval.id}:reject` },
          ],
        ],
      });
      if (message) sent.push(message);
    }
    if (sent.length > 0) await this.db.update(approvals).set({ telegramMessages: sent }).where(eq(approvals.id, approval.id));
  }

  async get(approvalId: string, user: User): Promise<Approval> {
    const [approval] = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, user.companyId)));
    if (!approval) throw notFound("Approval");
    return approval;
  }

  async decide(approvalId: string, user: User, decision: "approved" | "rejected", note?: string): Promise<Approval> {
    const current = await this.get(approvalId, user);
    if (!canApprove(user.role, current.approverRole)) throw forbidden(`This needs approval from the ${current.approverRole.replace("_", " ")}`);
    if (current.expiresAt && current.expiresAt < new Date() && current.status === "pending") {
      await this.db.update(approvals).set({ status: "expired" }).where(eq(approvals.id, approvalId));
      throw badRequest("This request has expired");
    }

    // Only one decision wins, even if two people press the button at once.
    const [claimed] = await this.db
      .update(approvals)
      .set({ status: decision, decidedBy: user.id, decidedAt: new Date(), decisionNote: note ?? null })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
      .returning();
    if (!claimed) throw conflict("This request has already been decided");

    await audit(this.db, {
      companyId: claimed.companyId,
      projectId: claimed.projectId,
      actor: { type: "user", id: user.id },
      action: `approval.${decision}`,
      subject: { type: "approval", id: claimed.id },
      ...(note ? { reason: note } : {}),
    });

    let final = claimed;
    if (decision === "approved") final = await this.execute(claimed, user);
    else await this.rejected(claimed, user);
    await this.clearButtons(final);
    return final;
  }

  private async rejected(approval: Approval, user: User): Promise<void> {
    const executor = this.executors.get(approval.action.type);
    if (!executor?.onReject) return;
    await executor.onReject(executor.schema.parse(approval.action), { db: this.db, approval, decidedBy: user });
  }

  private async execute(approval: Approval, user: User): Promise<Approval> {
    try {
      const executor = this.executor(approval.action.type);
      const action = executor.schema.parse(approval.action);
      const result = await executor.run(action, { db: this.db, approval, decidedBy: user });
      const [done] = await this.db
        .update(approvals)
        .set({ status: "executed", result: (result ?? null) as object | null })
        .where(eq(approvals.id, approval.id))
        .returning();
      await audit(this.db, {
        companyId: approval.companyId,
        projectId: approval.projectId,
        actor: { type: "user", id: user.id },
        action: `action.${approval.action.type}`,
        subject: { type: "approval", id: approval.id },
        reason: approval.title,
        data: { result },
      });
      return done!;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const [failed] = await this.db
        .update(approvals)
        .set({ status: "failed", result: { error: message } })
        .where(eq(approvals.id, approval.id))
        .returning();
      await audit(this.db, {
        companyId: approval.companyId,
        projectId: approval.projectId,
        actor: { type: "system", id: "approvals" },
        action: "action.failed",
        subject: { type: "approval", id: approval.id },
        reason: message,
      });
      return failed!;
    }
  }

  private async clearButtons(approval: Approval): Promise<void> {
    if (!this.bot) return;
    for (const { chatId, messageId } of approval.telegramMessages) {
      await this.bot.api.removeButtons(chatId, messageId).catch(() => undefined);
    }
  }

  /** Marks old unanswered requests as expired. */
  async expireOld(db: Executor = this.db, now = new Date()): Promise<number> {
    const expired = await db
      .update(approvals)
      .set({ status: "expired" })
      .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, now)))
      .returning({ id: approvals.id });
    return expired.length;
  }

  async list(user: User, filter: { status?: Approval["status"]; projectIds: string[] }): Promise<Approval[]> {
    const conditions = [eq(approvals.companyId, user.companyId)];
    if (filter.status) conditions.push(eq(approvals.status, filter.status));
    const rows = await this.db.select().from(approvals).where(and(...conditions));
    const visible = new Set(filter.projectIds);
    return rows
      .filter((a) => !a.projectId || visible.has(a.projectId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}

function evidenceLines(evidence: ApprovalEvidence[]): string[] {
  if (evidence.length === 0) return [];
  return ["", "Based on:", ...evidence.slice(0, 6).map((e) => `- ${e.label}`)];
}

