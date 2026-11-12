import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DASHBOARD_ROLES, MANAGER_ROLES } from "../auth/permissions.js";
import { audit } from "../audit.js";
import type { Database } from "../db/client.js";
import { projectMembers, projects, users } from "../db/schema.js";
import { defaultHolidays } from "../domain/holidays.js";
import { importedActivity, parseScheduleCsv } from "../domain/schedule-import.js";
import { requireRole } from "../http/auth.js";
import { badRequest, notFound } from "../http/errors.js";
import { getAccessibleProject, listAccessibleProjects } from "../services/access.js";
import { latestSnapshot, recalculate, replaceSchedule } from "../services/schedule.js";

const isoDate = z.iso.date();

const calendarSchema = z.object({
  workingWeekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  holidays: z.array(isoDate).max(200),
});

const projectBody = z
  .object({
    name: z.string().trim().min(2).max(160),
    client: z.string().trim().max(160).optional(),
    consultant: z.string().trim().max(160).optional(),
    locationName: z.string().trim().max(160).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    startDate: isoDate,
    contractFinish: isoDate,
    calendar: calendarSchema.optional(),
    liquidatedDamagesPerDay: z.number().nonnegative().optional(),
    retentionPercent: z.number().min(0).max(20).default(5),
    checkInTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("17:00"),
  })
  .refine((p) => p.contractFinish > p.startDate, { message: "The contract finish must be after the start", path: ["contractFinish"] });

const projectPatch = z
  .object({
    name: z.string().trim().min(2).max(160),
    client: z.string().trim().max(160).nullable(),
    consultant: z.string().trim().max(160).nullable(),
    locationName: z.string().trim().max(160).nullable(),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    contractFinish: isoDate,
    calendar: calendarSchema,
    liquidatedDamagesPerDay: z.number().nonnegative().nullable(),
    retentionPercent: z.number().min(0).max(20),
    checkInTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    active: z.boolean(),
  })
  .partial();

const projectParams = z.object({ projectId: z.uuid() });
const memberParams = z.object({ projectId: z.uuid(), userId: z.uuid() });

export function projectRoutes(app: FastifyInstance, db: Database): void {
  app.get("/projects", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    return { projects: await listAccessibleProjects(db, user) };
  });

  app.post("/projects", async (request, reply) => {
    const user = requireRole(request, MANAGER_ROLES);
    const body = projectBody.parse(request.body);
    const project = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(projects)
        .values({
          companyId: user.companyId,
          name: body.name,
          client: body.client ?? null,
          consultant: body.consultant ?? null,
          locationName: body.locationName ?? null,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
          startDate: body.startDate,
          contractFinish: body.contractFinish,
          dataDate: body.startDate,
          calendar: body.calendar ?? {
            workingWeekdays: [1, 2, 3, 4, 5, 6],
            holidays: defaultHolidays(body.startDate, body.contractFinish),
          },
          liquidatedDamagesPerDay: body.liquidatedDamagesPerDay ?? null,
          retentionPercent: body.retentionPercent,
          checkInTime: body.checkInTime,
        })
        .returning();
      await tx.insert(projectMembers).values({ projectId: created!.id, userId: user.id });
      await audit(tx, {
        companyId: user.companyId,
        projectId: created!.id,
        actor: { type: "user", id: user.id },
        action: "project.created",
        subject: { type: "project", id: created!.id },
      });
      return created!;
    });
    return reply.status(201).send({ project });
  });

  app.get("/projects/:projectId", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    const project = await getAccessibleProject(db, user, projectId);
    const members = await db
      .select({ id: users.id, name: users.name, role: users.role, linkedToTelegram: users.telegramUserId })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId));
    return {
      project,
      members: members.map((m) => ({ ...m, linkedToTelegram: m.linkedToTelegram !== null })),
    };
  });

  app.patch("/projects/:projectId", async (request) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId } = projectParams.parse(request.params);
    const project = await getAccessibleProject(db, user, projectId);
    const body = projectPatch.parse(request.body);
    if (body.contractFinish && body.contractFinish <= project.startDate) {
      throw badRequest("The contract finish must be after the start");
    }
    const [updated] = await db.update(projects).set(body).where(eq(projects.id, projectId)).returning();
    await audit(db, {
      companyId: user.companyId,
      projectId,
      actor: { type: "user", id: user.id },
      action: "project.updated",
      data: body,
    });
    return { project: updated };
  });

  app.put("/projects/:projectId/members/:userId", async (request, reply) => {
    const actor = requireRole(request, MANAGER_ROLES);
    const { projectId, userId } = memberParams.parse(request.params);
    await getAccessibleProject(db, actor, projectId);
    const [member] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.companyId, actor.companyId)));
    if (!member) throw notFound("User");
    await db.insert(projectMembers).values({ projectId, userId }).onConflictDoNothing();
    return reply.status(204).send();
  });

  app.delete("/projects/:projectId/members/:userId", async (request, reply) => {
    const actor = requireRole(request, MANAGER_ROLES);
    const { projectId, userId } = memberParams.parse(request.params);
    await getAccessibleProject(db, actor, projectId);
    await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
    return reply.status(204).send();
  });

  /** Accepts JSON ({ activities: [...] }) or a CSV file body. */
  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_request, body, done) => done(null, body));

  app.put("/projects/:projectId/schedule", async (request) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const force = (request.query as { force?: string }).force === "true";

    const imported =
      typeof request.body === "string"
        ? parseScheduleCsv(request.body)
        : z.object({ activities: z.array(importedActivity).min(1).max(5000) }).parse(request.body).activities;

    const { serialized } = await replaceSchedule(db, {
      projectId,
      companyId: user.companyId,
      actorId: user.id,
      activities: imported,
      force,
    });
    return { schedule: serialized };
  });

  app.get("/projects/:projectId/schedule", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const snapshot = await latestSnapshot(db, projectId);
    if (!snapshot) throw notFound("Schedule");
    return {
      schedule: {
        dataDate: snapshot.dataDate,
        finishDate: snapshot.finishDate,
        slipDays: snapshot.slipDays,
        criticalPath: snapshot.criticalPath,
        activities: snapshot.activities,
        calculatedAt: snapshot.createdAt,
        reason: snapshot.reason,
      },
    };
  });

  app.post("/projects/:projectId/schedule/recalculate", async (request) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const { serialized } = await recalculate(db, projectId, "Recalculated on request");
    return { schedule: serialized };
  });
}
