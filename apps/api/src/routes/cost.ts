import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DASHBOARD_ROLES, MANAGER_ROLES } from "../auth/permissions.js";
import { audit } from "../audit.js";
import type { Database } from "../db/client.js";
import { activities, boqItems, costCategory, costEntries, paymentClaims, projects } from "../db/schema.js";
import { boqItem, parseBoqCsv } from "../domain/boq-import.js";
import { ImportError } from "../domain/schedule-import.js";
import { proposeClaim } from "../features/cost.js";
import type { FeatureDeps } from "../features/types.js";
import { requireRole } from "../http/auth.js";
import { notFound } from "../http/errors.js";
import { getAccessibleProject } from "../services/access.js";
import { claimToCsv, earnedValueReport } from "../services/cost.js";

const projectParams = z.object({ projectId: z.uuid() });
const claimParams = z.object({ projectId: z.uuid(), claimId: z.uuid() });

const costEntryBody = z.object({
  date: z.iso.date(),
  category: z.enum(costCategory.enumValues),
  amount: z.number().positive(),
  description: z.string().trim().min(2).max(300),
});

export function costRoutes(app: FastifyInstance, db: Database, deps: FeatureDeps): void {
  app.put("/projects/:projectId/boq", async (request) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const items =
      typeof request.body === "string"
        ? parseBoqCsv(request.body)
        : z.object({ items: z.array(boqItem).min(1).max(5000) }).parse(request.body).items;

    const codes = await db.select({ id: activities.id, code: activities.code }).from(activities).where(eq(activities.projectId, projectId));
    const idByCode = new Map(codes.map((a) => [a.code, a.id]));
    const unknown = items.filter((i) => i.activityCode && !idByCode.has(i.activityCode)).map((i) => `Item ${i.itemNo}: activity ${i.activityCode} is not in the schedule`);
    if (unknown.length > 0) throw new ImportError("Some items point to activities that do not exist", unknown);

    await db.transaction(async (tx) => {
      await tx.delete(boqItems).where(eq(boqItems.projectId, projectId));
      await tx.insert(boqItems).values(
        items.map((item) => ({
          projectId,
          itemNo: item.itemNo,
          description: item.description,
          unit: item.unit,
          quantity: item.quantity,
          rate: item.rate,
          activityId: item.activityCode ? idByCode.get(item.activityCode)! : null,
        })),
      );
      await audit(tx, {
        companyId: user.companyId,
        projectId,
        actor: { type: "user", id: user.id },
        action: "boq.imported",
        reason: `${items.length} items`,
      });
    });
    const total = items.reduce((sum, i) => sum + i.quantity * i.rate, 0);
    return { items: items.length, contractValue: Math.round(total * 100) / 100 };
  });

  app.get("/projects/:projectId/boq", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const rows = await db
      .select({ item: boqItems, activityCode: activities.code })
      .from(boqItems)
      .leftJoin(activities, eq(activities.id, boqItems.activityId))
      .where(eq(boqItems.projectId, projectId))
      .orderBy(asc(boqItems.itemNo));
    return { items: rows.map((r) => ({ ...r.item, activityCode: r.activityCode, amount: Math.round(r.item.quantity * r.item.rate * 100) / 100 })) };
  });

  app.get("/projects/:projectId/cost", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    const project = await getAccessibleProject(db, user, projectId);
    return earnedValueReport(db, project);
  });

  app.post("/projects/:projectId/cost-entries", async (request, reply) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const body = costEntryBody.parse(request.body);
    const [entry] = await db.insert(costEntries).values({ projectId, ...body, sourceRef: null }).returning();
    await audit(db, {
      companyId: user.companyId,
      projectId,
      actor: { type: "user", id: user.id },
      action: "cost.recorded",
      subject: { type: "cost_entry", id: entry!.id },
      reason: body.description,
    });
    return reply.status(201).send({ entry });
  });

  app.put("/projects/:projectId/labour-rates", async (request) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const rates = z.record(z.string().trim().min(1).max(40), z.number().nonnegative()).parse(request.body);
    const [project] = await db.update(projects).set({ labourRates: rates }).where(eq(projects.id, projectId)).returning();
    return { labourRates: project!.labourRates };
  });

  app.get("/projects/:projectId/payment-claims", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const claims = await db.select().from(paymentClaims).where(eq(paymentClaims.projectId, projectId)).orderBy(desc(paymentClaims.number));
    return { claims };
  });

  /** Drafts the next claim now instead of waiting for month end. */
  app.post("/projects/:projectId/payment-claims", async (request, reply) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    const project = await getAccessibleProject(db, user, projectId);
    const { periodEnd } = z.object({ periodEnd: z.iso.date() }).parse(request.body);
    const claim = await proposeClaim(deps, project, periodEnd);
    return reply.status(201).send({ claim });
  });

  app.get("/projects/:projectId/payment-claims/:claimId/csv", async (request, reply) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId, claimId } = claimParams.parse(request.params);
    const project = await getAccessibleProject(db, user, projectId);
    const [claim] = await db
      .select()
      .from(paymentClaims)
      .where(and(eq(paymentClaims.id, claimId), eq(paymentClaims.projectId, projectId)));
    if (!claim) throw notFound("Payment claim");
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="payment-claim-${claim.number}.csv"`)
      .send(`﻿${claimToCsv(claim, project.name)}`);
  });
}
