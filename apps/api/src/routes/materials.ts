import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DASHBOARD_ROLES, MANAGER_ROLES } from "../auth/permissions.js";
import { audit } from "../audit.js";
import type { Database } from "../db/client.js";
import { activityKind, materials, materialTransactions, purchaseRequests, quotes, suppliers, users } from "../db/schema.js";
import { requireRole } from "../http/auth.js";
import { conflict, notFound } from "../http/errors.js";
import { getAccessibleProject } from "../services/access.js";
import { recomputeStock } from "../services/daily-logs.js";
import { forecastMaterials } from "../services/materials.js";

const projectParams = z.object({ projectId: z.uuid() });
const materialParams = z.object({ projectId: z.uuid(), materialId: z.uuid() });

const materialBody = z.object({
  name: z.string().trim().min(2).max(80),
  unit: z.string().trim().min(1).max(20),
  progressUnit: z.string().trim().max(20).optional(),
  consumedBy: z.array(z.enum(activityKind.enumValues)).default([]),
  usagePerUnit: z.number().positive().optional(),
  leadTimeDays: z.number().int().min(0).max(120).default(3),
  safetyDays: z.number().int().min(0).max(60).default(2),
  lastUnitPrice: z.number().positive().optional(),
  openingStock: z.number().min(0).default(0),
});

const materialPatch = materialBody.omit({ openingStock: true }).partial();
const adjustBody = z.object({ quantity: z.number().refine((q) => q !== 0, "Use a non-zero quantity"), note: z.string().trim().min(2).max(300) });

const supplierBody = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().toLowerCase().pipe(z.email()).optional(),
  materials: z.array(z.string().trim().min(1)).min(1),
  language: z.enum(["en", "am"]).default("en"),
});

export function materialRoutes(app: FastifyInstance, db: Database): void {
  app.get("/projects/:projectId/materials", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const forecasts = await forecastMaterials(db, projectId);
    return {
      materials: forecasts.map((f) => ({
        ...f.material,
        usagePerUnit: f.usagePerUnit,
        dailyUse: Math.round(f.dailyUse * 100) / 100,
        runOutDate: f.runOutDate,
        orderBy: f.orderBy,
        status: f.status,
        openOrderQuantity: f.openOrderQuantity,
      })),
    };
  });

  app.post("/projects/:projectId/materials", async (request, reply) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId } = projectParams.parse(request.params);
    const project = await getAccessibleProject(db, user, projectId);
    const body = materialBody.parse(request.body);
    const [existing] = await db
      .select({ id: materials.id })
      .from(materials)
      .where(and(eq(materials.projectId, projectId), sql`lower(${materials.name}) = ${body.name.toLowerCase()}`));
    if (existing) throw conflict(`${body.name} is already tracked on this project`);

    const material = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(materials)
        .values({
          projectId,
          name: body.name,
          unit: body.unit,
          progressUnit: body.progressUnit ?? null,
          consumedBy: body.consumedBy,
          usagePerUnit: body.usagePerUnit ?? null,
          leadTimeDays: body.leadTimeDays,
          safetyDays: body.safetyDays,
          lastUnitPrice: body.lastUnitPrice ?? null,
        })
        .returning();
      if (body.openingStock > 0) {
        await tx.insert(materialTransactions).values({
          materialId: created!.id,
          date: project.dataDate,
          kind: "adjustment",
          quantity: body.openingStock,
          note: "Opening stock",
        });
        await recomputeStock(tx, [created!.id]);
      }
      const [fresh] = await tx.select().from(materials).where(eq(materials.id, created!.id));
      return fresh!;
    });
    return reply.status(201).send({ material });
  });

  app.patch("/projects/:projectId/materials/:materialId", async (request) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId, materialId } = materialParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const body = materialPatch.parse(request.body);
    const [updated] = await db
      .update(materials)
      .set(body)
      .where(and(eq(materials.id, materialId), eq(materials.projectId, projectId)))
      .returning();
    if (!updated) throw notFound("Material");
    return { material: updated };
  });

  /** Stock count correction, e.g. after a physical count on site. */
  app.post("/projects/:projectId/materials/:materialId/adjust", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId, materialId } = materialParams.parse(request.params);
    const project = await getAccessibleProject(db, user, projectId);
    const body = adjustBody.parse(request.body);
    const [material] = await db
      .select()
      .from(materials)
      .where(and(eq(materials.id, materialId), eq(materials.projectId, projectId)));
    if (!material) throw notFound("Material");
    await db.transaction(async (tx) => {
      await tx.insert(materialTransactions).values({ materialId, date: project.dataDate, kind: "adjustment", quantity: body.quantity, note: body.note });
      await recomputeStock(tx, [materialId]);
      await audit(tx, {
        companyId: user.companyId,
        projectId,
        actor: { type: "user", id: user.id },
        action: "material.adjusted",
        subject: { type: "material", id: materialId },
        reason: body.note,
        data: { quantity: body.quantity },
      });
    });
    const [fresh] = await db.select().from(materials).where(eq(materials.id, materialId));
    return { material: fresh };
  });

  app.get("/projects/:projectId/materials/:materialId/transactions", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId, materialId } = materialParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const rows = await db
      .select({ tx: materialTransactions })
      .from(materialTransactions)
      .innerJoin(materials, eq(materials.id, materialTransactions.materialId))
      .where(and(eq(materialTransactions.materialId, materialId), eq(materials.projectId, projectId)))
      .orderBy(desc(materialTransactions.date), desc(materialTransactions.createdAt));
    return { transactions: rows.map((r) => r.tx) };
  });

  app.get("/projects/:projectId/purchase-requests", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const rows = await db
      .select({ request: purchaseRequests, material: materials })
      .from(purchaseRequests)
      .innerJoin(materials, eq(materials.id, purchaseRequests.materialId))
      .where(eq(purchaseRequests.projectId, projectId))
      .orderBy(desc(purchaseRequests.createdAt));
    const allQuotes = rows.length
      ? await db
          .select({ quote: quotes, supplierName: suppliers.name })
          .from(quotes)
          .innerJoin(suppliers, eq(suppliers.id, quotes.supplierId))
          .where(
            inArray(
              quotes.purchaseRequestId,
              rows.map((r) => r.request.id),
            ),
          )
      : [];
    return {
      purchaseRequests: rows.map((r) => ({
        ...r.request,
        material: { id: r.material.id, name: r.material.name, unit: r.material.unit },
        quotes: allQuotes
          .filter((q) => q.quote.purchaseRequestId === r.request.id)
          .map((q) => ({ ...q.quote, supplierName: q.supplierName }))
          .sort((a, b) => a.unitPriceEtb - b.unitPriceEtb),
      })),
    };
  });

  app.get("/suppliers", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const rows = await db
      .select({ supplier: suppliers, telegramLinked: users.telegramUserId })
      .from(suppliers)
      .leftJoin(users, eq(users.id, suppliers.userId))
      .where(eq(suppliers.companyId, user.companyId));
    return { suppliers: rows.map((r) => ({ ...r.supplier, telegramLinked: r.telegramLinked !== null })) };
  });

  /** Adds a supplier with a SiteMate account they can link to Telegram with an invite code. */
  app.post("/suppliers", async (request, reply) => {
    const user = requireRole(request, MANAGER_ROLES);
    const body = supplierBody.parse(request.body);
    const supplier = await db.transaction(async (tx) => {
      const [account] = await tx
        .insert(users)
        .values({ companyId: user.companyId, name: body.name, role: "supplier", phone: body.phone ?? null, language: body.language })
        .returning();
      const [created] = await tx
        .insert(suppliers)
        .values({
          companyId: user.companyId,
          name: body.name,
          userId: account!.id,
          phone: body.phone ?? null,
          email: body.email ?? null,
          materials: body.materials,
        })
        .returning();
      return created!;
    });
    return reply.status(201).send({ supplier });
  });
}
