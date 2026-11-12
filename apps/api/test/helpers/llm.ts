import { createHash } from "node:crypto";
import { EMBEDDING_DIMENSIONS } from "../../src/db/schema.js";
import {
  normalize,
  type EmbeddingTask,
  type GenerateRequest,
  type GenerateResult,
  type LlmClient,
} from "../../src/ai/llm.js";

type Responder = (request: GenerateRequest<unknown>) => unknown | undefined;

/**
 * Scripted model. Each responder sees the request and returns an answer or
 * undefined to pass. Answers are validated against the request schema just
 * like real model output, so a wrong fixture fails loudly.
 */
export class FakeLlm implements LlmClient {
  readonly model = "fake-model";
  requests: GenerateRequest<unknown>[] = [];
  private responders: Responder[] = [];

  respond(responder: Responder): this {
    this.responders.push(responder);
    return this;
  }

  /** Answers requests whose system prompt contains `marker`. */
  when(marker: string, answer: unknown | ((request: GenerateRequest<unknown>) => unknown)): this {
    return this.respond((request) =>
      request.system.includes(marker) ? (typeof answer === "function" ? (answer as (r: unknown) => unknown)(request) : answer) : undefined,
    );
  }

  reset(): void {
    this.requests = [];
    this.responders = [];
  }

  async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    this.requests.push(request as GenerateRequest<unknown>);
    for (const responder of [...this.responders].reverse()) {
      const answer = responder(request as GenerateRequest<unknown>);
      if (answer !== undefined) {
        return { value: request.schema.parse(answer), usage: { inputTokens: 100, outputTokens: 50 }, model: this.model };
      }
    }
    throw new Error(`FakeLlm has no answer for: ${request.system.slice(0, 80)}`);
  }

  /**
   * Bag of words hashed into the embedding space. Texts that share words end
   * up close together, which is enough to test retrieval for real.
   */
  async embed(texts: string[], _task: EmbeddingTask): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        if (word.length < 2) continue;
        const bucket = createHash("md5").update(word).digest().readUInt32BE(0) % EMBEDDING_DIMENSIONS;
        vector[bucket]! += 1;
      }
      return normalize(vector);
    });
  }
}

/** Text of all parts of the last request. */
export function lastPrompt(llm: FakeLlm): string {
  const last = llm.requests.at(-1);
  return (last?.parts ?? []).map((p) => ("text" in p ? p.text : `[${p.inlineData.mimeType}]`)).join("\n");
}
