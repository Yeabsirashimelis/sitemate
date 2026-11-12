import { and, count, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DASHBOARD_ROLES, MANAGER_ROLES } from "../auth/permissions.js";
import { audit } from "../audit.js";
import type { Database } from "../db/client.js";
import { documentChunks, documentFiles, documentKind, documents } from "../db/schema.js";
import { askProject, INDEX_DOCUMENT_JOB } from "../features/documents.js";
import type { FeatureDeps } from "../features/types.js";
import { requireRole } from "../http/auth.js";
import { badRequest, notFound } from "../http/errors.js";
import { enqueue } from "../jobs/queue.js";
import { getAccessibleProject } from "../services/access.js";
import { PDF_TYPE, searchDocuments, TEXT_TYPES } from "../services/documents.js";

const MAX_FILE_BYTES = 15 * 1024 * 1024;

const projectParams = z.object({ projectId: z.uuid() });
const documentParams = z.object({ projectId: z.uuid(), documentId: z.uuid() });

const uploadBody = z.object({
  title: z.string().trim().min(2).max(200),
  kind: z.enum(documentKind.enumValues),
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string().refine((m) => m === PDF_TYPE || TEXT_TYPES.has(m), "Upload a PDF or a text file"),
  contentBase64: z.string().min(1),
});

export function documentRoutes(app: FastifyInstance, db: Database, deps: FeatureDeps, onQueued: () => void): void {
  app.post("/projects/:projectId/documents", { bodyLimit: 22 * 1024 * 1024 }, async (request, reply) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const body = uploadBody.parse(request.body);
    const data = Buffer.from(body.contentBase64, "base64");
    if (data.length === 0) throw badRequest("The file is empty");
    if (data.length > MAX_FILE_BYTES) throw badRequest("Files up to 15 MB can be uploaded");

    const document = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(documents)
        .values({ projectId, title: body.title, kind: body.kind, fileName: body.fileName, mimeType: body.mimeType, uploadedBy: user.id })
        .returning();
      await tx.insert(documentFiles).values({ documentId: created!.id, data });
      await enqueue(tx, INDEX_DOCUMENT_JOB, { documentId: created!.id }, { idempotencyKey: `index:${created!.id}` });
      await audit(tx, {
        companyId: user.companyId,
        projectId,
        actor: { type: "user", id: user.id },
        action: "document.uploaded",
        subject: { type: "document", id: created!.id },
        reason: body.title,
      });
      return created!;
    });
    onQueued();
    return reply.status(202).send({ document });
  });

  app.get("/projects/:projectId/documents", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const rows = await db
      .select({ document: documents, chunks: count(documentChunks.id) })
      .from(documents)
      .leftJoin(documentChunks, eq(documentChunks.documentId, documents.id))
      .where(eq(documents.projectId, projectId))
      .groupBy(documents.id)
      .orderBy(desc(documents.createdAt));
    return { documents: rows.map((r) => ({ ...r.document, chunks: Number(r.chunks) })) };
  });

  app.delete("/projects/:projectId/documents/:documentId", async (request, reply) => {
    const user = requireRole(request, MANAGER_ROLES);
    const { projectId, documentId } = documentParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const deleted = await db
      .delete(documents)
      .where(and(eq(documents.id, documentId), eq(documents.projectId, projectId)))
      .returning();
    if (deleted.length === 0) throw notFound("Document");
    return reply.status(204).send();
  });

  app.get("/projects/:projectId/documents/search", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    await getAccessibleProject(db, user, projectId);
    const { q } = z.object({ q: z.string().trim().min(2).max(500) }).parse(request.query);
    return { results: await searchDocuments(db, deps.llm, { projectId, question: q, limit: 8 }) };
  });

  /** "Ask SiteMate": answers from project records and documents, with sources. */
  app.post("/projects/:projectId/ask", async (request) => {
    const user = requireRole(request, DASHBOARD_ROLES);
    const { projectId } = projectParams.parse(request.params);
    const project = await getAccessibleProject(db, user, projectId);
    const { question } = z.object({ question: z.string().trim().min(3).max(1000) }).parse(request.body);
    return askProject(deps, project, question);
  });
}
