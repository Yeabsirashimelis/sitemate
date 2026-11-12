import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApprovalService } from "../approvals/service.js";
import { DASHBOARD_ROLES } from "../auth/permissions.js";
import type { Database } from "../db/client.js";
import { approvalStatus } from "../db/schema.js";
import { requireRole } from "../http/auth.js";
import { listAccessibleProjects } from "../services/access.js";

const listQuery = z.object({ status: z.enum(approvalStatus.enumValues).optional() });
const params = z.object({ approvalId: z.uuid() });
const decisionBody = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(1000).optional(),
});

export function approvalRoutes(app: FastifyInstance, db: Database, approvals: ApprovalService): void {
  app.get("/approvals", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { status } = listQuery.parse(request.query);
    const projectIds = (await listAccessibleProjects(db, user)).map((p) => p.id);
    return { approvals: await approvals.list(user, { ...(status ? { status } : {}), projectIds }) };
  });

  app.get("/approvals/:approvalId", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { approvalId } = params.parse(request.params);
    return { approval: await approvals.get(approvalId, user) };
  });

  app.post("/approvals/:approvalId/decision", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { approvalId } = params.parse(request.params);
    const body = decisionBody.parse(request.body);
    const approval = await approvals.decide(approvalId, user, body.decision === "approve" ? "approved" : "rejected", body.note);
    return { approval };
  });
}
