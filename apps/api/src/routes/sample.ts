import type { FastifyInstance } from "fastify";
import { MANAGER_ROLES } from "../auth/permissions.js";
import { audit } from "../audit.js";
import { localDate } from "../domain/time.js";
import type { FeatureDeps } from "../features/types.js";
import { requireRole } from "../http/auth.js";
import { addSampleProject } from "../seed/sample.js";

export function sampleRoutes(app: FastifyInstance, deps: FeatureDeps): void {
  // Builds seven weeks of history, so it is limited per caller.
  app.post("/projects/sample", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    const user = requireRole(request, MANAGER_ROLES);
    const result = await addSampleProject(deps.db, {
      user,
      today: localDate(deps.now(), deps.config.SITE_TIME_ZONE),
      indexDocuments: !!deps.config.GEMINI_API_KEY,
    });
    await audit(deps.db, {
      companyId: user.companyId,
      projectId: result.projectId,
      actor: { type: "user", id: user.id },
      action: "project.sample_created",
      reason: `${result.activities} activities and ${result.logs} days of site reports`,
    });
    deps.runner.poke();
    return reply.code(201).send({ projectId: result.projectId });
  });
}
