/**
 * Project memory: indexed documents, "Ask SiteMate", and checking site
 * reports against the specification.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { tracedGenerate } from "../ai/agent-run.js";
import { LlmError } from "../ai/llm.js";
import {
  ANSWER_SYSTEM,
  answerSchema,
  DOCUMENTS_AGENT,
  SPEC_CHECK_SYSTEM,
  specCheckSchema,
} from "../agents/documents-agent.js";
import { activities, approvals, dailyLogs, documents, projects } from "../db/schema.js";
import { longDate } from "../domain/format.js";
import { EVENTS } from "../events.js";
import { forecastMaterials } from "../services/materials.js";
import { hasIndexedDocuments, indexDocument, searchDocuments, type SearchHit } from "../services/documents.js";
import { latestSnapshot, type Project } from "../services/schedule.js";
import { notifyProject } from "./notify.js";
import type { FeatureDeps } from "./types.js";

export const INDEX_DOCUMENT_JOB = "documents.index";

export function registerDocumentsFeature(deps: FeatureDeps): void {
  const { db, runner, events, bot } = deps;

  runner.register(INDEX_DOCUMENT_JOB, {
    schema: z.object({ documentId: z.uuid() }),
    handle: async ({ documentId }, { job }) => {
      try {
        await indexDocument(db, deps.llm, documentId);
      } catch (error) {
        const retryable = error instanceof LlmError && error.retryable;
        if (retryable && job.attempts < job.maxAttempts) throw error;
        await db
          .update(documents)
          .set({ status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : String(error) })
          .where(eq(documents.id, documentId));
      }
    },
  });

  // Owners and project managers can ask questions on Telegram.
  bot?.onMessage(async ({ user, project, message }) => {
    if (!project || (user.role !== "owner" && user.role !== "project_manager")) return false;
    if (message.kind !== "text" || !message.text || message.text.startsWith("/")) return false;
    const answer = await askProject(deps, project, message.text);
    await bot.sendToUser(user, formatAnswer(answer), { projectId: project.id });
    return true;
  });

  events.subscribe(EVENTS.dailyLogCompleted, "spec-check", z.object({ dailyLogId: z.uuid(), projectId: z.uuid() }), async ({ dailyLogId }) => {
    await checkAgainstSpecification(deps, dailyLogId);
  });
}

export interface ProjectAnswer {
  found: boolean;
  answer: string;
  sources: Array<{ id: string; label: string; ref: string }>;
}

/** Facts from the project's own records, numbered R1, R2 ... for citation. */
async function projectRecords(deps: FeatureDeps, project: Project): Promise<Array<{ id: string; label: string; ref: string; text: string }>> {
  const { db } = deps;
  const records: Array<{ label: string; ref: string; text: string }> = [];

  const snapshot = await latestSnapshot(db, project.id);
  if (snapshot) {
    const acts = snapshot.activities as Array<{ code: string; name: string; status: string; critical: boolean; totalFloat: number; finishDate: string; percentComplete: number }>;
    const open = acts.filter((a) => a.status !== "complete");
    records.push({
      label: `Schedule as of ${snapshot.dataDate}`,
      ref: `schedule:${snapshot.id}`,
      text:
        `Forecast handover ${snapshot.finishDate} (${snapshot.slipDays > 0 ? `${snapshot.slipDays} workdays late` : snapshot.slipDays < 0 ? `${-snapshot.slipDays} workdays early` : "on time"}). ` +
        `Critical path: ${snapshot.criticalPath.join(", ")}. ` +
        `Open activities: ${open
          .slice(0, 25)
          .map((a) => `${a.code} ${a.name} ${a.percentComplete}% finish ${a.finishDate}${a.critical ? " critical" : ` float ${a.totalFloat}`}`)
          .join("; ")}.`,
    });
  }

  const logs = await db.select().from(dailyLogs).where(eq(dailyLogs.projectId, project.id)).orderBy(desc(dailyLogs.logDate)).limit(6);
  for (const log of logs) {
    const issues = log.issues.map((i) => `${i.kind}${i.activityCode ? ` on ${i.activityCode}` : ""}: ${i.description}`).join("; ");
    records.push({
      label: `Daily log ${log.logDate}`,
      ref: `daily_log:${log.id}`,
      text: `${log.summary ?? ""}${issues ? ` Issues: ${issues}.` : ""} Workers: ${log.workers.map((w) => `${w.count} ${w.trade}`).join(", ") || "not reported"}.`,
    });
  }

  const materials = await forecastMaterials(db, project.id);
  if (materials.length) {
    records.push({
      label: "Materials",
      ref: "materials",
      text: materials
        .map((m) => `${m.material.name}: ${Math.round(m.material.onHand)} ${m.material.unit} on site${m.runOutDate ? `, runs out ${m.runOutDate}` : ""}${m.openOrderQuantity ? `, ${m.openOrderQuantity} on order` : ""}`)
        .join("; "),
    });
  }

  const pending = await db.select().from(approvals).where(eq(approvals.projectId, project.id));
  const waiting = pending.filter((a) => a.status === "pending");
  if (waiting.length) {
    records.push({ label: "Waiting for approval", ref: "approvals", text: waiting.map((a) => a.title).join("; ") });
  }
  return records.map((r, i) => ({ ...r, id: `R${i + 1}` }));
}

function hitLabel(hit: SearchHit): string {
  return `${hit.documentTitle}${hit.clause ? `, clause ${hit.clause}` : ""}${hit.page ? `, page ${hit.page}` : ""}`;
}

export async function askProject(deps: FeatureDeps, project: Project, question: string): Promise<ProjectAnswer> {
  const records = await projectRecords(deps, project);
  let hits: SearchHit[] = [];
  if (await hasIndexedDocuments(deps.db, project.id, ["contract", "specification", "boq", "letter", "minutes", "other"])) {
    hits = await searchDocuments(deps.db, deps.llm, { projectId: project.id, question, limit: 6 });
  }
  const sources = [
    ...records.map((r) => ({ id: r.id, label: r.label, ref: r.ref, text: r.text })),
    ...hits.map((h, i) => ({ id: `S${i + 1}`, label: hitLabel(h), ref: `chunk:${h.id}`, text: h.content })),
  ];
  const prompt = [
    `Project: ${project.name}. Today's data date: ${project.dataDate}.`,
    "",
    "Sources:",
    ...sources.map((s) => `[${s.id}] ${s.label}\n${s.text}`),
    "",
    `Question: ${question}`,
  ].join("\n");

  const { value } = await tracedGenerate(
    deps.db,
    deps.llm,
    { agent: DOCUMENTS_AGENT, trigger: "ask", companyId: project.companyId, projectId: project.id, inputSummary: { question, sources: sources.map((s) => s.id) } },
    { system: ANSWER_SYSTEM, parts: [{ text: prompt }], schema: answerSchema },
  );

  // Only sources that were actually given can be cited.
  const byId = new Map(sources.map((s) => [s.id, s]));
  const cited = [...new Set(value.citations)].filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  if (!value.found || (cited.length === 0 && sources.length > 0)) {
    return {
      found: false,
      answer: value.found ? "I could not find a source for that in the project records or documents." : value.answer,
      sources: [],
    };
  }
  return { found: true, answer: value.answer, sources: cited.map(({ id, label, ref }) => ({ id, label, ref })) };
}

export function formatAnswer(answer: ProjectAnswer): string {
  if (!answer.found || answer.sources.length === 0) return answer.answer;
  return `${answer.answer}\n\nSources: ${answer.sources.map((s) => s.label).join("; ")}`;
}

/** Flags reported work that clearly conflicts with the specification. */
export async function checkAgainstSpecification(deps: FeatureDeps, dailyLogId: string): Promise<number> {
  const { db } = deps;
  const [row] = await db
    .select({ log: dailyLogs, project: projects })
    .from(dailyLogs)
    .innerJoin(projects, eq(projects.id, dailyLogs.projectId))
    .where(eq(dailyLogs.id, dailyLogId));
  if (!row || row.log.progress.length === 0) return 0;
  if (!(await hasIndexedDocuments(db, row.project.id, ["specification"]))) return 0;

  const codes = row.log.progress.slice(0, 4).map((p) => p.activityCode);
  const names = await db
    .select({ code: activities.code, name: activities.name })
    .from(activities)
    .where(and(eq(activities.projectId, row.project.id), inArray(activities.code, codes)));
  const nameByCode = new Map(names.map((n) => [n.code, n.name]));

  const hits: SearchHit[] = [];
  for (const code of codes) {
    const found = await searchDocuments(db, deps.llm, {
      projectId: row.project.id,
      question: `${nameByCode.get(code) ?? code} ${row.log.summary ?? ""}`,
      limit: 3,
      kinds: ["specification"],
    });
    for (const hit of found) if (!hits.some((h) => h.id === hit.id)) hits.push(hit);
  }
  if (hits.length === 0) return 0;

  const report = [
    `Daily log ${row.log.logDate}: ${row.log.summary ?? ""}`,
    ...row.log.progress.map((p) => `${p.activityCode} ${nameByCode.get(p.activityCode) ?? ""}: ${p.percentComplete}%${p.note ? `, ${p.note}` : ""}`),
    "",
    "Specification clauses:",
    ...hits.map((h, i) => `[S${i + 1}] ${hitLabel(h)}\n${h.content}`),
  ].join("\n");

  const { value } = await tracedGenerate(
    db,
    deps.llm,
    { agent: DOCUMENTS_AGENT, trigger: `spec_check:${dailyLogId}`, companyId: row.project.companyId, projectId: row.project.id },
    { system: SPEC_CHECK_SYSTEM, parts: [{ text: report }], schema: specCheckSchema },
  );

  const valid = value.conflicts.filter((c) => /^S\d+$/.test(c.sourceId) && hits[Number(c.sourceId.slice(1)) - 1]);
  for (const conflict of valid) {
    const hit = hits[Number(conflict.sourceId.slice(1)) - 1]!;
    await notifyProject(deps, {
      companyId: row.project.companyId,
      projectId: row.project.id,
      title: `Possible specification issue on ${conflict.activityCode}`,
      text: `Daily log ${longDate(row.log.logDate)}: ${conflict.reported}. ${hitLabel(hit)} requires: ${conflict.requirement}. Please check before the work is covered up.`,
      requestedBy: DOCUMENTS_AGENT,
    });
  }
  return valid.length;
}
