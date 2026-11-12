import { and, eq, inArray } from "drizzle-orm";
import { hasRole, MANAGER_ROLES } from "../auth/permissions.js";
import type { User } from "../auth/sessions.js";
import type { Executor } from "../db/client.js";
import { projectMembers, projects } from "../db/schema.js";
import { notFound } from "../http/errors.js";
import type { Project } from "./schedule.js";

/**
 * Owners and project managers see every project in their company. Everyone
 * else sees only the projects they are a member of. A project in another
 * company is reported as not found, never as forbidden.
 */
export async function getAccessibleProject(db: Executor, user: User, projectId: string): Promise<Project> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, user.companyId)));
  if (!project) throw notFound("Project");
  if (hasRole(user.role, MANAGER_ROLES)) return project;

  const [membership] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.id)));
  if (!membership) throw notFound("Project");
  return project;
}

export async function listAccessibleProjects(db: Executor, user: User): Promise<Project[]> {
  if (hasRole(user.role, MANAGER_ROLES)) {
    return db.select().from(projects).where(eq(projects.companyId, user.companyId));
  }
  const memberships = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id));
  if (memberships.length === 0) return [];
  return db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.companyId, user.companyId),
        inArray(
          projects.id,
          memberships.map((m) => m.projectId),
        ),
      ),
    );
}
