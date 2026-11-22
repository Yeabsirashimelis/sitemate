import { computeSchedule } from "@sitemate/engine";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MANAGER_ROLES } from "../auth/permissions.js";
import { tracedGenerate } from "../ai/agent-run.js";
import { SCHEDULE_BUILDER_AGENT, buildingDescriptionSchema, scheduleBuilderPrompt, toParameters } from "../agents/schedule-builder-agent.js";
import { boqItems, projects } from "../db/schema.js";
import { buildingParameters, buildingSchedule, describeParameters, type BuildingParameters } from "../domain/building-template.js";
import type { FeatureDeps } from "../features/types.js";
import { requireRole } from "../http/auth.js";
import { AppError, notFound } from "../http/errors.js";
import { getAccessibleProject } from "../services/access.js";
import { loadProjectSchedule, projectCalendar, replaceSchedule } from "../services/schedule.js";

const projectParams = z.object({ projectId: z.uuid() });
const draftBody = z.union([
  z.object({ description: z.string().trim().min(10).max(4000) }),
  z.object({ parameters: buildingParameters }),
]);
const buildBody = z.object({ parameters: buildingParameters, force: z.boolean().default(false) });

/**
 * "Describe your project": the model only reads the description into a few
 * numbers; the schedule itself always comes from the template, so the same
 * numbers give the same programme every time.
 */
export function scheduleBuilderRoutes(app: FastifyInstance, deps: FeatureDeps): void {
  const { db } = deps;

  async function project(projectId: string) {
    const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!row) throw notFound("Project");
    return row;
  }

  app.post("/projects/:projectId/schedule/draft", { config: { rateLimit: { max: 30, timeWindow: "1 hour" } } }, async (request) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const body = draftBody.parse(request.body);

    let parameters: BuildingParameters;
    let assumptions: string[] = [];
    if ("description" in body) {
      let found;
      try {
        ({ value: found } = await tracedGenerate(
          db,
          deps.llm,
          { agent: SCHEDULE_BUILDER_AGENT, trigger: `schedule-draft:${projectId}`, companyId: user.companyId, projectId },
          { system: scheduleBuilderPrompt(), parts: [{ text: body.description }], schema: buildingDescriptionSchema },
        ));
      } catch {
        throw new AppError(503, "ai_unavailable", "SiteMate could not read the description just now. Fill in the numbers below instead.");
      }
      ({ parameters, assumptions } = toParameters(found));
    } else {
      parameters = body.parameters;
    }

    const list = buildingSchedule(parameters);
    const result = computeSchedule(
      list.map((a) => ({ id: a.code, name: a.name, duration: a.duration, predecessors: a.predecessors.map((p) => ({ from: p.code, type: p.type, lag: p.lag })) })),
      projectCalendar(await project(projectId)),
    );
    const cost = list.reduce((sum, a) => sum + (a.plannedQuantity && a.rate ? a.plannedQuantity * a.rate : 0), 0);
    return {
      parameters,
      summary: describeParameters(parameters),
      assumptions,
      activities: list.length,
      finishDate: result.finishDate,
      estimatedCost: Math.round(cost),
      preview: list.map((a) => ({ code: a.code, name: a.name, zone: a.zone ?? null, duration: a.duration })),
    };
  });

  app.post("/projects/:projectId/schedule/build", async (request) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const { parameters, force } = buildBody.parse(request.body);
    const list = buildingSchedule(parameters);

    const { serialized } = await replaceSchedule(db, { projectId, companyId: user.companyId, actorId: user.id, activities: list, force });

    // A starting bill of quantities at typical rates, unless the project already has its own.
    const [hasBoq] = await db.select({ id: boqItems.id }).from(boqItems).where(eq(boqItems.projectId, projectId)).limit(1);
    let boq = 0;
    if (!hasBoq) {
      const schedule = await loadProjectSchedule(db, projectId);
      const priced = list.filter((a) => a.plannedQuantity && a.rate);
      await db.insert(boqItems).values([
        { projectId, itemNo: "1.1", description: "Preliminaries, site setup and insurance", unit: "LS", quantity: 1, rate: 450_000, activityId: null },
        ...priced.map((a, i) => ({
          projectId,
          itemNo: `${2 + Math.floor(i / 9)}.${(i % 9) + 1}`,
          description: a.name,
          unit: a.boqUnit ?? a.progressUnit!,
          quantity: Math.round(a.plannedQuantity! * 100) / 100,
          rate: a.rate!,
          activityId: schedule.byCode.get(a.code)?.id ?? null,
        })),
      ]);
      boq = priced.length + 1;
    }
    return { schedule: serialized, boqItems: boq };
  });
}
