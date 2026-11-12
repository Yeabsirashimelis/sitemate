import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DASHBOARD_ROLES, MANAGER_ROLES } from "../auth/permissions.js";
import type { Database } from "../db/client.js";
import { calendarEvents } from "../db/schema.js";
import { syncProjectCalendar } from "../features/calendar.js";
import type { FeatureDeps } from "../features/types.js";
import { requireRole } from "../http/auth.js";
import { AppError } from "../http/errors.js";
import { getAccessibleProject } from "../services/access.js";

const projectParams = z.object({ projectId: z.uuid() });

export function calendarRoutes(app: FastifyInstance, db: Database, deps: FeatureDeps): void {
  app.get("/projects/:projectId/calendar", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const [stats] = await db
      .select({ events: sql<number>`count(*)::int`, lastSyncedAt: sql<string | null>`max(${calendarEvents.syncedAt})` })
      .from(calendarEvents)
      .where(eq(calendarEvents.projectId, projectId));
    return { connected: deps.calendar !== null, events: stats?.events ?? 0, lastSyncedAt: stats?.lastSyncedAt ? new Date(stats.lastSyncedAt).toISOString() : null };
  });

  app.post("/projects/:projectId/calendar/sync", async (request) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    if (!deps.calendar) throw new AppError(409, "calendar_off", "No Google Calendar is connected. Set GOOGLE_CALENDAR_ID and the service account key.");
    return { result: await syncProjectCalendar(deps, projectId) };
  });
}
