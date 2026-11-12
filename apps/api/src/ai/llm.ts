/**
 * Language model access.
 *
 * Every call asks for JSON that matches a Zod schema. The schema is sent to
 * Gemini as a JSON schema so the model is constrained while generating, and
 * the answer is validated again here before any code uses it. A reply that
 * still does not match is retried once with the validation errors attached.
 */

import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GenerateRequest<T> {
  /** What the model is and the rules it follows. */
  system: string;
  /** The input: text, images, audio or PDFs. */
  parts: Part[];
  schema: z.ZodType<T>;
  temperature?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateResult<T> {
  value: T;
  usage: Usage;
  model: string;
}

export type EmbeddingTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface LlmClient {
  readonly model: string;
  generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>>;
  /** Unit-length vectors, one per text, in the same order. */
  embed(texts: string[], task: EmbeddingTask): Promise<number[][]>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export class LlmNotConfiguredError extends LlmError {
  constructor() {
    super("GEMINI_API_KEY is not set, so AI features are switched off", false);
    this.name = "LlmNotConfiguredError";
  }
}

export function normalize(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((v) => v / length);
}

/** JSON schema for Gemini. Gemini accepts a subset, so meta keys are removed. */
export function toGeminiSchema(schema: z.ZodType): unknown {
  const json = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface GeminiOptions {
  apiKey: string;
  model: string;
  embeddingModel: string;
  embeddingDimensions: number;
  /** Attempts for rate limits and server errors. */
  maxAttempts?: number;
  /** First retry delay; doubles each time. */
  retryDelayMs?: number;
  /** Used when the main model stays overloaded or rate limited. */
  fallbackModel?: string | undefined;
}

export class GeminiClient implements LlmClient {
  readonly model: string;
  private readonly ai: GoogleGenAI;

  constructor(private readonly options: GeminiOptions) {
    this.model = options.model;
    this.ai = new GoogleGenAI({ apiKey: options.apiKey });
  }

  private async withRetry<T>(call: () => Promise<T>): Promise<T> {
    const attempts = this.options.maxAttempts ?? 4;
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        const status = error instanceof ApiError ? error.status : undefined;
        const retryable = status === 429 || (status !== undefined && status >= 500);
        if (!retryable || attempt >= attempts) {
          throw new LlmError(error instanceof Error ? error.message : String(error), retryable);
        }
        const base = this.options.retryDelayMs ?? 2000;
        await sleep(Math.min(base * 2 ** (attempt - 1), 20_000) + Math.random() * (base / 4));
      }
    }
  }

  /**
   * Uses the main model, and the fallback model when the main one is still
   * overloaded or rate limited after its retries.
   */
  async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    try {
      return await this.generateWith(this.model, request);
    } catch (error) {
      const fallback = this.options.fallbackModel;
      if (!fallback || fallback === this.model || !(error instanceof LlmError) || !error.retryable) throw error;
      return this.generateWith(fallback, request);
    }
  }

  private async generateWith<T>(model: string, request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let parts = request.parts;

    for (let round = 1; round <= 2; round++) {
      const response = await this.withRetry(() =>
        this.ai.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: {
            systemInstruction: request.system,
            responseMimeType: "application/json",
            responseJsonSchema: toGeminiSchema(request.schema),
            temperature: request.temperature ?? 0.2,
          },
        }),
      );
      usage.inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
      usage.outputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;

      const text = response.text ?? "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const result = request.schema.safeParse(parsed);
      if (result.success) return { value: result.data, usage, model };

      const problems = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      if (round === 2) throw new LlmError(`Model output did not match the schema: ${problems}`, false);
      parts = [
        ...request.parts,
        { text: `Your previous answer was not valid: ${problems}. Answer again with JSON that matches the schema exactly.` },
      ];
    }
    throw new LlmError("unreachable", false);
  }

  async embed(texts: string[], task: EmbeddingTask): Promise<number[][]> {
    const vectors: number[][] = [];
    // The API takes up to 100 inputs per call.
    for (let start = 0; start < texts.length; start += 100) {
      const batch = texts.slice(start, start + 100);
      const response = await this.withRetry(() =>
        this.ai.models.embedContent({
          model: this.options.embeddingModel,
          contents: batch,
          config: { taskType: task, outputDimensionality: this.options.embeddingDimensions },
        }),
      );
      const embeddings = response.embeddings ?? [];
      if (embeddings.length !== batch.length) {
        throw new LlmError(`Expected ${batch.length} embeddings, got ${embeddings.length}`, true);
      }
      for (const embedding of embeddings) vectors.push(normalize(embedding.values ?? []));
    }
    return vectors;
  }
}

/** Used when no API key is configured: every call fails clearly instead of crashing at startup. */
export class DisabledLlm implements LlmClient {
  readonly model = "disabled";
  async generate<T>(): Promise<GenerateResult<T>> {
    throw new LlmNotConfiguredError();
  }
  async embed(): Promise<number[][]> {
    throw new LlmNotConfiguredError();
  }
}
