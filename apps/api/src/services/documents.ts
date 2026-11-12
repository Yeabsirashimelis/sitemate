/**
 * Document indexing and search.
 *
 * Text documents are split at clause headings directly; PDFs are read into
 * clauses by Gemini first. Every piece is embedded and stored next to a
 * full text index, and search combines both rankings, so exact terms like
 * "C25" or "clause 14.3" are found as well as questions asked in other words.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { tracedGenerate } from "../ai/agent-run.js";
import type { LlmClient } from "../ai/llm.js";
import { DOCUMENTS_AGENT, PDF_SYSTEM, pdfSectionsSchema } from "../agents/documents-agent.js";
import { queryRows, type Executor } from "../db/client.js";
import { documentChunks, documentFiles, documents, projects } from "../db/schema.js";
import { chunkSections, clausesMentioned, splitIntoSections, type Section } from "../domain/chunking.js";

export type DocumentRow = typeof documents.$inferSelect;

export const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);
export const PDF_TYPE = "application/pdf";

async function readSections(db: Executor, llm: LlmClient, document: DocumentRow, data: Buffer, companyId: string): Promise<Section[]> {
  if (TEXT_TYPES.has(document.mimeType)) return splitIntoSections(data.toString("utf8"));
  if (document.mimeType === PDF_TYPE) {
    const { value } = await tracedGenerate(
      db,
      llm,
      { agent: DOCUMENTS_AGENT, trigger: `document:${document.id}`, companyId, projectId: document.projectId },
      { system: PDF_SYSTEM, parts: [{ inlineData: { mimeType: PDF_TYPE, data: data.toString("base64") } }], schema: pdfSectionsSchema },
    );
    return value.sections.filter((s) => s.text.trim().length > 0);
  }
  throw new Error(`Cannot read files of type ${document.mimeType}`);
}

/** Reads, splits, embeds and stores a document. Safe to run again: old pieces are replaced. */
export async function indexDocument(db: Executor, llm: LlmClient, documentId: string): Promise<number> {
  const [row] = await db
    .select({ document: documents, file: documentFiles, companyId: projects.companyId })
    .from(documents)
    .innerJoin(projects, eq(projects.id, documents.projectId))
    .leftJoin(documentFiles, eq(documentFiles.documentId, documents.id))
    .where(eq(documents.id, documentId));
  if (!row) throw new Error(`Document ${documentId} not found`);
  if (!row.file) {
    if (row.document.status === "indexed") return 0;
    throw new Error("The uploaded file is missing");
  }

  const sections = await readSections(db, llm, row.document, row.file.data, row.companyId);
  const chunks = chunkSections(sections);
  if (chunks.length === 0) throw new Error("No readable text found in the document");
  const vectors = await llm.embed(
    chunks.map((c) => `${row.document.title}${c.clause ? ` clause ${c.clause}` : ""}${c.heading ? ` ${c.heading}` : ""}\n${c.text}`),
    "RETRIEVAL_DOCUMENT",
  );

  await db.transaction(async (tx) => {
    await tx.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
    for (let start = 0; start < chunks.length; start += 50) {
      await tx.insert(documentChunks).values(
        chunks.slice(start, start + 50).map((chunk, i) => ({
          documentId,
          projectId: row.document.projectId,
          ordinal: chunk.ordinal,
          clause: chunk.clause,
          heading: chunk.heading,
          page: chunk.page,
          content: chunk.text,
          embedding: vectors[start + i]!,
        })),
      );
    }
    await tx.update(documents).set({ status: "indexed", error: null }).where(eq(documents.id, documentId));
    await tx.delete(documentFiles).where(eq(documentFiles.documentId, documentId));
  });
  return chunks.length;
}

export interface SearchHit {
  id: string;
  documentId: string;
  documentTitle: string;
  documentKind: string;
  clause: string | null;
  heading: string | null;
  page: number | null;
  content: string;
  score: number;
}

const STOPWORDS = new Set(
  "the a an of to in on for and or is are was were be what which who how when where do does did we our us with by at as it this that from can should must any all".split(" "),
);

/** Words of the question as an OR query, so a passage matching some of them still counts. */
export function textQuery(question: string): string | null {
  const words = (question.toLowerCase().match(/[\p{L}\p{N}]+(?:\.[\p{N}]+)*/gu) ?? []).filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return words.length ? [...new Set(words)].join(" | ") : null;
}

/**
 * Hybrid search: vector similarity and full text ranking combined with
 * reciprocal rank fusion. Clauses named in the question go first.
 */
export async function searchDocuments(
  db: Executor,
  llm: LlmClient,
  input: { projectId: string; question: string; limit?: number; kinds?: string[] },
): Promise<SearchHit[]> {
  const limit = input.limit ?? 6;
  const [vector] = await llm.embed([input.question], "RETRIEVAL_QUERY");
  const vectorLiteral = JSON.stringify(vector);
  const tsquery = textQuery(input.question);
  const kindFilter = input.kinds?.length
    ? sql`and d.kind in (${sql.join(
        input.kinds.map((k) => sql`${k}`),
        sql`, `,
      )})`
    : sql``;

  const rows = await queryRows<SearchHit>(
    db,
    sql`
      with vec as (
        select c.id, row_number() over (order by c.embedding <=> ${vectorLiteral}::vector) as r
        from document_chunks c join documents d on d.id = c.document_id
        where c.project_id = ${input.projectId} and c.embedding is not null ${kindFilter}
        order by c.embedding <=> ${vectorLiteral}::vector
        limit 20
      ),
      txt as (
        select c.id, row_number() over (order by ts_rank(to_tsvector('simple', c.content), to_tsquery('simple', ${tsquery ?? "x"})) desc) as r
        from document_chunks c join documents d on d.id = c.document_id
        where ${tsquery ? sql`true` : sql`false`} and c.project_id = ${input.projectId} ${kindFilter}
          and to_tsvector('simple', c.content) @@ to_tsquery('simple', ${tsquery ?? "x"})
        limit 20
      )
      select c.id, c.document_id as "documentId", d.title as "documentTitle", d.kind as "documentKind",
             c.clause, c.heading, c.page, c.content,
             coalesce(1.0 / (60 + vec.r), 0) + coalesce(1.0 / (60 + txt.r), 0) as score
      from document_chunks c
      join documents d on d.id = c.document_id
      left join vec on vec.id = c.id
      left join txt on txt.id = c.id
      where vec.id is not null or txt.id is not null
      order by score desc
      limit ${limit * 2}
    `,
  );

  const named = clausesMentioned(input.question);
  let exact: SearchHit[] = [];
  if (named.length > 0) {
    exact = await queryRows<SearchHit>(
      db,
      sql`
        select c.id, c.document_id as "documentId", d.title as "documentTitle", d.kind as "documentKind",
               c.clause, c.heading, c.page, c.content, 1.0 as score
        from document_chunks c join documents d on d.id = c.document_id
        where c.project_id = ${input.projectId} ${kindFilter}
          and c.clause in (${sql.join(
            named.map((n) => sql`${n}`),
            sql`, `,
          )})
        order by c.ordinal
        limit ${limit}
      `,
    );
  }

  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  for (const hit of [...exact, ...rows]) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    merged.push({ ...hit, score: Number(hit.score) });
  }
  return merged.slice(0, limit);
}

export async function hasIndexedDocuments(db: Executor, projectId: string, kinds: string[]): Promise<boolean> {
  const [row] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.status, "indexed"), inArray(documents.kind, kinds as DocumentRow["kind"][])))
    .limit(1);
  return !!row;
}
