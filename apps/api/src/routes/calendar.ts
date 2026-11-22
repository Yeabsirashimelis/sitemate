import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DASHBOARD_ROLES, MANAGER_ROLES } from "../auth/permissions.js";
import { audit } from "../audit.js";
import type { Database } from "../db/client.js";
import { calendarEvents, companies, projects } from "../db/schema.js";
import { CALENDAR_SYNC_JOB, syncProjectCalendar } from "../features/calendar.js";
import type { FeatureDeps } from "../features/types.js";
import { requireRole } from "../http/auth.js";
import { AppError, badRequest } from "../http/errors.js";
import { enqueue } from "../jobs/queue.js";
import { getAccessibleProject } from "../services/access.js";

const projectParams = z.object({ projectId: z.uuid() });
const connectBody = z.object({ calendarId: z.string().trim().min(5).max(300).nullable() });

export function calendarRoutes(app: FastifyInstance, db: Database, deps: FeatureDeps): void {
  app.get("/projects/:projectId/calendar", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const [company] = await db.select({ calendarId: companies.googleCalendarId }).from(companies).where(eq(companies.id, user.companyId));
    const [stats] = await db
      .select({ events: sql<number>`count(*)::int`, lastSyncedAt: sql<string | null>`max(${calendarEvents.syncedAt})` })
      .from(calendarEvents)
      .where(eq(calendarEvents.projectId, projectId));
    return {
      // Whether this server can write to Google at all, and whether this company has picked a calendar.
      available: deps.calendar !== null,
      connected: deps.calendar !== null && !!company?.calendarId,
      calendarId: company?.calendarId ?? null,
      shareWith: deps.calendar?.accountEmail ?? null,
      events: stats?.events ?? 0,
      lastSyncedAt: stats?.lastSyncedAt ? new Date(stats.lastSyncedAt).toISOString() : null,
    };
  });

  /** Connects the company's own Google Calendar, or disconnects it with null. */
  app.put("/company/calendar", async (request) => {
    const user = requireRole(request, MANAGER_ROLES);
    if (!deps.calendar) throw new AppError(409, "calendar_off", "Google Calendar is not set up on this server");
    const { calendarId } = connectBody.parse(request.body);
    if (calendarId && !(await deps.calendar.canWrite(calendarId))) {
      throw badRequest(`SiteMate cannot reach that calendar. Share it with ${deps.calendar.accountEmail} and choose "Make changes to events", then try again.`);
    }
    await db.update(companies).set({ googleCalendarId: calendarId }).where(eq(companies.id, user.companyId));
    await audit(db, {
      companyId: user.companyId,
      actor: { type: "user", id: user.id },
      action: calendarId ? "calendar.connected" : "calendar.disconnected",
    });
    // Fill the new calendar, or take everything off the old one.
    const own = await db.select({ id: projects.id }).from(projects).where(eq(projects.companyId, user.companyId));
    for (const project of own) {
      await enqueue(db, CALENDAR_SYNC_JOB, { projectId: project.id }, { idempotencyKey: `calendar:${project.id}:${calendarId ?? "off"}:${Date.now()}` });
    }
    deps.runner.poke();
    return { calendarId };
  });

  app.post("/projects/:projectId/calendar/sync", async (request) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    if (!deps.calendar) throw new AppError(409, "calendar_off", "Google Calendar is not set up on this server");
    const [company] = await db.select({ calendarId: companies.googleCalendarId }).from(companies).where(eq(companies.id, user.companyId));
    if (!company?.calendarId) throw new AppError(409, "calendar_off", "Connect your company's Google Calendar first");
    return { result: await syncProjectCalendar(deps, projectId) };
  });
}
