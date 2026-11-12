/**
 * Policy: what an agent may do on its own and what waits for a person.
 *
 * The rules are code, not prompt text, so no model output can talk its way
 * past them. Collecting, recording and reminding run on their own. Anything
 * that changes the plan, spends money or goes outside the company needs the
 * right person, and large purchases need the owner.
 */

import type { Role } from "../auth/permissions.js";
import type { approvalKind } from "../db/schema.js";

export type ApprovalKind = (typeof approvalKind.enumValues)[number];
/** Actions an agent always does on its own. They are recorded in the audit log, never queued for approval. */
export type AutoKind = "reminder" | "notification" | "record";
export type ActionKind = ApprovalKind | AutoKind;

export interface ProposedAction {
  kind: ActionKind;
  /** Executor that runs it, e.g. "schedule.apply_recovery". */
  type: string;
  /** Money committed by the action, in birr, if any. */
  amountEtb?: number;
}

export type Decision = { mode: "auto" } | { mode: "approval"; approverRole: Role };

export interface PolicyOptions {
  /** Purchases above this need the owner instead of the project manager. */
  ownerApprovalThresholdEtb: number;
}

const NEEDS_PROJECT_MANAGER: ReadonlySet<ApprovalKind> = new Set([
  "schedule_change",
  "recovery_plan",
  "purchase_request",
  "supplier_message",
  "consultant_rfi",
  "delay_notice",
  "payment_claim",
  "client_report",
]);

export function decide(action: ProposedAction, options: PolicyOptions): Decision {
  if (!NEEDS_PROJECT_MANAGER.has(action.kind as ApprovalKind)) return { mode: "auto" };
  if ((action.kind === "purchase_request" || action.kind === "recovery_plan") && (action.amountEtb ?? 0) > options.ownerApprovalThresholdEtb) {
    return { mode: "approval", approverRole: "owner" };
  }
  return { mode: "approval", approverRole: "project_manager" };
}
