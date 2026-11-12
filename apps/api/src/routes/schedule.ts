import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DASHBOARD_ROLES, MANAGER_ROLES } from "../auth/permissions.js";
import { audit } from "../audit.js";
import type { Database } from "../db/client.js";
import { activities, activityLinks, recoveryMeasures, weeklyPlans } from "../db/schema.js";
import { whatIf } from "../features/schedule.js";
import { requireRole } from "../http/auth.js";
import { badRequest, notFound } from "../http/errors.js";
import { getAccessibleProject } from "../services/access.js";
import { buildLookahead } from "../services/lookahead.js";

const projectParams = z.object({ projectId: z.uuid() });
const measureParams = z.object({ projectId: z.uuid(), measureId: z.uuid() });

const measureBody = z.object({
  activityCode: z.string().trim().min(1),
  description: z.string().trim().min(3).max(300),
  change: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shorten"), days: z.number().int().min(1).max(365) }),
    z.object({
      kind: z.literal("relink"),
      fromActivityCode: z.string().trim().min(1),
      type: z.enum(["FS", "SS", "FF", "SF"]),
      lag: z.number().int().min(-365).max(365),
    }),
  ]),
  cost: z.number().nonnegative(),
  risk: z.enum(["low", "medium", "high"]),
});

const whatIfBody = z.object({ activityCode: z.string().trim().min(1), days: z.number().int().min(1).max(365) });

export function scheduleRoutes(app: FastifyInstance, db: Database): void {
  app.get("/projects/:projectId/recovery-measures", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const rows = await db
      .select({ measure: recoveryMeasures, activityCode: activities.code, activityName: activities.name })
      .from(recoveryMeasures)
      .innerJoin(activities, eq(activities.id, recoveryMeasures.activityId))
      .where(eq(recoveryMeasures.projectId, projectId))
      .orderBy(asc(activities.code));
    return { measures: rows.map((r) => ({ ...r.measure, activityCode: r.activityCode, activityName: r.activityName })) };
  });

  app.post("/projects/:projectId/recovery-measures", async (request, reply) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const body = measureBody.parse(request.body);

    const byCode = async (code: string) => {
      const [row] = await db
        .select()
        .from(activities)
        .where(and(eq(activities.projectId, projectId), eq(activities.code, code)));
      if (!row) throw badRequest(`Activity ${code} is not in this schedule`);
      return row;
    };
    const activity = await byCode(body.activityCode);

    let change: typeof recoveryMeasures.$inferInsert.change;
    if (body.change.kind === "shorten") {
      if (body.change.days >= activity.duration) throw badRequest("An activity cannot be shortened to nothing");
      change = { kind: "shorten", days: body.change.days };
    } else {
      const from = await byCode(body.change.fromActivityCode);
      const [link] = await db
        .select()
        .from(activityLinks)
        .where(and(eq(activityLinks.fromActivityId, from.id), eq(activityLinks.toActivityId, activity.id)));
      if (!link) throw badRequest(`${activity.code} does not depend on ${from.code}`);
      change = { kind: "relink", fromActivityId: from.id, type: body.change.type, lag: body.change.lag };
    }

    const [measure] = await db
      .insert(recoveryMeasures)
      .values({ projectId, activityId: activity.id, description: body.description, change, cost: body.cost, risk: body.risk })
      .returning();
    await audit(db, {
      companyId: user.companyId,
      projectId,
      actor: { type: "user", id: user.id },
      action: "recovery_measure.created",
      subject: { type: "recovery_measure", id: measure!.id },
    });
    return reply.status(201).send({ measure });
  });

  app.delete("/projects/:projectId/recovery-measures/:measureId", async (request, reply) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId, measureId } = measureParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const deleted = await db
      .delete(recoveryMeasures)
      .where(and(eq(recoveryMeasures.id, measureId), eq(recoveryMeasures.projectId, projectId)))
      .returning();
    if (deleted.length === 0) throw notFound("Recovery measure");
    return reply.status(204).send();
  });

  app.get("/projects/:projectId/lookahead", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const lookahead = await buildLookahead(db, projectId);
    const plans = await db.select().from(weeklyPlans).where(eq(weeklyPlans.projectId, projectId)).orderBy(asc(weeklyPlans.weekStart));
    return {
      ...lookahead,
      plans: plans.map((p) => ({ weekStart: p.weekStart, weekEnd: p.weekEnd, committed: p.committed, completed: p.completed, percentPlanComplete: p.percentPlanComplete })),
    };
  });

  /** Tries a delay on a copy of the schedule. Nothing is saved. */
  app.post("/projects/:projectId/what-if", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const body = whatIfBody.parse(request.body);
    return { result: await whatIf(db, projectId, body.activityCode, body.days) };
  });
}
