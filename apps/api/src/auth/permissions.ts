import type { userRole } from "../db/schema.js";

export type Role = (typeof userRole.enumValues)[number];

/** Roles that use the web dashboard. Everyone else works through Telegram. */
export const DASHBOARD_ROLES: readonly Role[] = ["owner", "project_manager", "site_engineer"];

/** Roles that may add people and change project setup. */
export const MANAGER_ROLES: readonly Role[] = ["owner", "project_manager"];

export function hasRole(role: Role, allowed: readonly Role[]): boolean {
  return allowed.includes(role);
}

/**
 * Who may approve which kind of action. Above the owner threshold a purchase
 * needs the owner rather than the project manager.
 */
export function canApprove(role: Role, approverRole: Role): boolean {
  if (role === "owner") return true;
  return role === approverRole;
}
