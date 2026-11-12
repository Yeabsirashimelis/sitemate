/**
 * Notifications to the people running a project. Sending one is something an
 * agent may do on its own, so it goes through the policy as a notification
 * and ends up in the audit log like every other action.
 */

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { projectMembers, users } from "../db/schema.js";
import type { FeatureDeps } from "./types.js";

export const NOTIFY_PROJECT = "notify.project";

const notifyAction = z.object({
  projectId: z.uuid(),
  text: z.string().min(1).max(4000),
  roles: z.array(z.enum(["owner", "project_manager", "site_engineer", "supervisor"])).default(["project_manager"]),
});

export function registerNotifyFeature(deps: FeatureDeps): void {
  deps.approvals.register(NOTIFY_PROJECT, notifyAction, async (action, context) => {
    if (!deps.bot) return { sent: 0 };
    const members = await context.db
      .select({ user: users })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(and(eq(projectMembers.projectId, action.projectId), eq(users.active, true), inArray(users.role, action.roles)));

    let recipients = members.map((m) => m.user);
    if (recipients.length === 0 && action.roles.includes("project_manager")) {
      // No project manager on the project: the owners hear about it instead.
      recipients = await context.db
        .select()
        .from(users)
        .where(and(eq(users.companyId, context.approval.companyId), eq(users.role, "owner"), eq(users.active, true)));
    }
    let sent = 0;
    for (const user of recipients) {
      if (await deps.bot.sendToUser(user, action.text, { projectId: action.projectId })) sent++;
    }
    return { sent };
  });
}

/** Tells the project managers something without asking them to decide anything. */
export function notifyProject(deps: FeatureDeps, input: { companyId: string; projectId: string; title: string; text: string; requestedBy: string }) {
  return deps.approvals.propose({
    companyId: input.companyId,
    projectId: input.projectId,
    kind: "notification",
    title: input.title,
    summary: input.text,
    action: { type: NOTIFY_PROJECT, projectId: input.projectId, text: input.text },
    requestedBy: input.requestedBy,
  });
}
