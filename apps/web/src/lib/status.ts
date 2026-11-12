import type { Tone } from "../components/ui";
import { shortDate } from "./format";
import type { MaterialRow } from "./types";

/** Handover status from workdays of slip against the contract date. */
export function slipTone(slipDays: number | null | undefined): Tone {
  if (slipDays === null || slipDays === undefined) return "neutral";
  if (slipDays > 5) return "critical";
  if (slipDays > 0) return "warning";
  return "good";
}

/** Schedule or cost performance index: 1.0 is on plan. */
export function indexTone(value: number | null | undefined): Tone {
  if (value === null || value === undefined) return "neutral";
  if (value < 0.9) return "critical";
  if (value < 0.98) return "warning";
  return "good";
}

export const readinessTone = { ready: "good", at_risk: "warning", blocked: "critical" } as const satisfies Record<string, Tone>;
export const readinessLabel = { ready: "Ready", at_risk: "At risk", blocked: "Blocked" } as const;

export const materialTone = { ok: "good", order_soon: "warning", order_now: "critical", no_usage_data: "neutral" } as const satisfies Record<string, Tone>;
export const materialLabel = { ok: "Covered", order_soon: "Order soon", order_now: "Order now", no_usage_data: "No usage yet" } as const;

/**
 * What a planner should read for one material. The API counts a raised
 * request as cover so the agent does not ask twice, but until it arrives the
 * page says it is on request rather than covered.
 */
export function materialState(m: Pick<MaterialRow, "status" | "orderBy" | "openOrderQuantity">): { tone: Tone; label: string; needsAction: boolean } {
  if (m.openOrderQuantity > 0 && m.status === "ok") return { tone: "info", label: "Order raised", needsAction: !!m.orderBy };
  if (m.status === "ok" && m.orderBy) return { tone: "info", label: `Order by ${shortDate(m.orderBy)}`, needsAction: false };
  return { tone: materialTone[m.status], label: materialLabel[m.status], needsAction: m.status === "order_now" || m.status === "order_soon" };
}
