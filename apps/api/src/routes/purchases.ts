import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MANAGER_ROLES } from "../auth/permissions.js";
import { reopenPurchaseRequest } from "../features/procurement.js";
import { recordQuote } from "../features/quotes.js";
import type { FeatureDeps } from "../features/types.js";
import { requireRole } from "../http/auth.js";
import { badRequest, conflict, notFound } from "../http/errors.js";

const params = z.object({ purchaseRequestId: z.uuid() });
const quoteBody = z.object({
  supplierId: z.uuid(),
  unitPrice: z.number().positive(),
  currency: z.string().trim().length(3).default("ETB"),
  leadTimeDays: z.number().int().min(0).max(120),
  note: z.string().trim().max(300).optional(),
});

export function purchaseRoutes(app: FastifyInstance, deps: FeatureDeps): void {
  /** A price got by phone, for suppliers who are not on Telegram. */
  app.post("/purchase-requests/:purchaseRequestId/quotes", async (request, reply) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { purchaseRequestId } = params.parse(request.params);
    const body = quoteBody.parse(request.body);
    const result = await recordQuote(deps, { purchaseRequestId, ...body, userId: user.id, companyId: user.companyId });
    if (result.error === "not_found") throw notFound("Purchase request");
    if (result.error === "unknown_supplier") throw badRequest("That supplier is not on your list");
    if (result.error === "closed") throw conflict(`This request is already ${result.status}, prices can no longer be added`);
    return reply.code(201).send({ proposed: result.proposed });
  });

  /** Undo for a request turned down by mistake. */
  app.post("/purchase-requests/:purchaseRequestId/reopen", async (request) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { purchaseRequestId } = params.parse(request.params);
    const result = await reopenPurchaseRequest(deps, { purchaseRequestId, companyId: user.companyId });
    if (result.error === "not_found") throw notFound("Purchase request");
    if (result.error === "not_cancelled") throw conflict("Only a cancelled request can be reopened");
    if (result.error === "newer_open") throw conflict("A newer request for this material is already open, use that one");
    return { step: result.step };
  });
}
