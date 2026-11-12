import { addCalendarDays } from "@sitemate/engine";
import { and, desc, eq, max } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DASHBOARD_ROLES, MANAGER_ROLES } from "../auth/permissions.js";
import type { Database } from "../db/client.js";
import { activities, claimEvents, rfis } from "../db/schema.js";
import { longDate } from "../domain/format.js";
import { recordRfiAnswer, SEND_RFI } from "../features/claims.js";
import type { FeatureDeps } from "../features/types.js";
import { requireRole } from "../http/auth.js";
import { badRequest, notFound } from "../http/errors.js";
import { getAccessibleProject } from "../services/access.js";

const projectParams = z.object({ projectId: z.uuid() });
const rfiParams = z.object({ projectId: z.uuid(), rfiId: z.uuid() });
const claimParams = z.object({ projectId: z.uuid(), claimId: z.uuid() });

const rfiBody = z.object({
  question: z.string().trim().min(10).max(2000),
  activityCode: z.string().trim().min(1).optional(),
  dueInDays: z.number().int().min(1).max(60).default(7),
});

export function claimRoutes(app: FastifyInstance, db: Database, deps: FeatureDeps): void {
  app.get("/projects/:projectId/rfis", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const rows = await db
      .select({ rfi: rfis, activityCode: activities.code })
      .from(rfis)
      .leftJoin(activities, eq(activities.id, rfis.activityId))
      .where(eq(rfis.projectId, projectId))
      .orderBy(desc(rfis.number));
    return { rfis: rows.map((r) => ({ ...r.rfi, activityCode: r.activityCode })) };
  });

  /** Drafts a request for information; it goes to the consultant once the project manager approves. */
  app.post("/projects/:projectId/rfis", async (request, reply) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    const project = await getAccessibleProject(db, user, projectId);
    const body = rfiBody.parse(request.body);

    let activityId: string | null = null;
    if (body.activityCode) {
      const [activity] = await db
        .select()
        .from(activities)
        .where(and(eq(activities.projectId, projectId), eq(activities.code, body.activityCode)));
      if (!activity) throw badRequest(`Activity ${body.activityCode} is not in the schedule`);
      activityId = activity.id;
    }

    const rfi = await db.transaction(async (tx) => {
      const [{ last }] = (await tx.select({ last: max(rfis.number) }).from(rfis).where(eq(rfis.projectId, projectId))) as [{ last: number | null }];
      const raisedOn = project.dataDate;
      const [created] = await tx
        .insert(rfis)
        .values({
          projectId,
          number: (last ?? 0) + 1,
          question: body.question,
          activityId,
          status: "pending_approval",
          raisedOn,
          dueOn: addCalendarDays(raisedOn, body.dueInDays),
        })
        .returning();
      return created!;
    });

    await deps.approvals.propose({
      companyId: project.companyId,
      projectId,
      kind: "consultant_rfi",
      title: `Send RFI ${rfi.number} to ${project.consultant ?? "the consultant"}`,
      summary: `${rfi.question}\n\nAnswer requested by ${longDate(rfi.dueOn)}.${body.activityCode ? ` Needed for ${body.activityCode}.` : ""}`,
      action: { type: SEND_RFI, rfiId: rfi.id },
      requestedBy: user.id,
    });
    return reply.status(201).send({ rfi });
  });

  app.post("/projects/:projectId/rfis/:rfiId/answer", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId, rfiId } = rfiParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const body = z.object({ answer: z.string().trim().min(2).max(4000), answeredOn: z.iso.date() }).parse(request.body);
    const [rfi] = await db.select().from(rfis).where(and(eq(rfis.id, rfiId), eq(rfis.projectId, projectId)));
    if (!rfi) throw notFound("RFI");
    try {
      return await recordRfiAnswer(deps, { rfiId, answer: body.answer, answeredOn: body.answeredOn, actorId: user.id, companyId: user.companyId });
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : "Could not record the answer");
    }
  });

  app.get("/projects/:projectId/claims", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const events = await db.select().from(claimEvents).where(eq(claimEvents.projectId, projectId)).orderBy(desc(claimEvents.startedOn));
    const claimableDays = events.filter((e) => e.status !== "closed").reduce((sum, e) => sum + e.delayDays, 0);
    return { events, totals: { open: events.filter((e) => e.status === "open").length, claimableDays } };
  });

  app.patch("/projects/:projectId/claims/:claimId", async (request) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId, claimId } = claimParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const body = z.object({ status: z.literal("closed"), endedOn: z.iso.date().optional() }).parse(request.body);
    const [event] = await db
      .update(claimEvents)
      .set({ status: body.status, ...(body.endedOn ? { endedOn: body.endedOn } : {}) })
      .where(and(eq(claimEvents.id, claimId), eq(claimEvents.projectId, projectId)))
      .returning();
    if (!event) throw notFound("Claim event");
    return { event };
  });
}
