/**
 * Every agent call is recorded: which agent, why it ran, what it saw, what it
 * returned, tokens and time. This is what the dashboard's agent activity view
 * and the evaluation reports read, and how usage is kept inside free limits.
 */

import type { Executor } from "../db/client.js";
import { agentRuns } from "../db/schema.js";
import type { GenerateRequest, GenerateResult, LlmClient } from "./llm.js";

export interface AgentRunInfo {
  agent: string;
  trigger: string;
  companyId?: string | null;
  projectId?: string | null;
  /** A short, safe description of the input. Media is never stored here. */
  inputSummary?: unknown;
}

/** Inline media is replaced by its type and size before anything is stored. */
export function summarizeParts(parts: GenerateRequest<unknown>["parts"]): unknown[] {
  return parts.map((part) =>
    "text" in part
      ? { text: part.text.length > 4000 ? `${part.text.slice(0, 4000)}…` : part.text }
      : { media: part.inlineData.mimeType, bytes: Math.round((part.inlineData.data.length * 3) / 4) },
  );
}

export async function tracedGenerate<T>(
  db: Executor,
  llm: LlmClient,
  info: AgentRunInfo,
  request: GenerateRequest<T>,
): Promise<GenerateResult<T>> {
  const started = Date.now();
  try {
    const result = await llm.generate(request);
    await db.insert(agentRuns).values({
      companyId: info.companyId ?? null,
      projectId: info.projectId ?? null,
      agent: info.agent,
      trigger: info.trigger,
      model: result.model,
      input: info.inputSummary ?? summarizeParts(request.parts),
      output: result.value as object,
      status: "ok",
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    await db.insert(agentRuns).values({
      companyId: info.companyId ?? null,
      projectId: info.projectId ?? null,
      agent: info.agent,
      trigger: info.trigger,
      model: llm.model,
      input: info.inputSummary ?? summarizeParts(request.parts),
      status: "error",
      error: error instanceof Error ? error.message.slice(0, 2000) : String(error),
      durationMs: Date.now() - started,
    });
    throw error;
  }
}
