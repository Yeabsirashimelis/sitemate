import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const generateContent = vi.fn();
const embedContent = vi.fn();

vi.mock("@google/genai", () => {
  class ApiError extends Error {
    status: number;
    constructor({ message, status }: { message: string; status: number }) {
      super(message);
      this.status = status;
    }
  }
  class GoogleGenAI {
    models = { generateContent, embedContent };
  }
  return { ApiError, GoogleGenAI };
});

const { ApiError } = await import("@google/genai");
const { GeminiClient, DisabledLlm, LlmError, normalize, toGeminiSchema } = await import("../src/ai/llm.js");
const { tracedGenerate } = await import("../src/ai/agent-run.js");
const { agentRuns } = await import("../src/db/schema.js");
const { createTestDatabase } = await import("./helpers/db.js");

const schema = z.object({ summary: z.string(), workers: z.number().int() });
const client = () =>
  new GeminiClient({ apiKey: "k", model: "gemini-test", embeddingModel: "emb", embeddingDimensions: 3, retryDelayMs: 1 });

const reply = (text: string) => ({ text, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });

beforeEach(() => {
  generateContent.mockReset();
  embedContent.mockReset();
});

describe("GeminiClient.generate", () => {
  it("sends the schema and returns validated output", async () => {
    generateContent.mockResolvedValueOnce(reply('{"summary":"Slab poured","workers":14}'));
    const result = await client().generate({ system: "sys", parts: [{ text: "hi" }], schema });
    expect(result.value).toEqual({ summary: "Slab poured", workers: 14 });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const call = generateContent.mock.calls[0]![0];
    expect(call.model).toBe("gemini-test");
    expect(call.config.responseMimeType).toBe("application/json");
    expect(call.config.responseJsonSchema.properties.workers.type).toBe("integer");
  });

  it("asks again once when the output does not match, and counts both calls", async () => {
    generateContent
      .mockResolvedValueOnce(reply('{"summary":"x","workers":"many"}'))
      .mockResolvedValueOnce(reply('{"summary":"x","workers":3}'));
    const result = await client().generate({ system: "sys", parts: [{ text: "hi" }], schema });
    expect(result.value.workers).toBe(3);
    expect(result.usage.inputTokens).toBe(20);
    const retryParts = generateContent.mock.calls[1]![0].contents[0].parts;
    expect(retryParts.at(-1).text).toMatch(/workers/);
  });

  it("gives up after a second invalid answer", async () => {
    generateContent.mockResolvedValue(reply("not json"));
    await expect(client().generate({ system: "s", parts: [{ text: "x" }], schema })).rejects.toBeInstanceOf(LlmError);
  });

  it("retries rate limits and server errors, but not bad requests", async () => {
    generateContent
      .mockRejectedValueOnce(new ApiError({ message: "slow down", status: 429 }))
      .mockRejectedValueOnce(new ApiError({ message: "oops", status: 503 }))
      .mockResolvedValueOnce(reply('{"summary":"ok","workers":1}'));
    await expect(client().generate({ system: "s", parts: [{ text: "x" }], schema })).resolves.toBeDefined();
    expect(generateContent).toHaveBeenCalledTimes(3);

    generateContent.mockReset();
    generateContent.mockRejectedValueOnce(new ApiError({ message: "bad", status: 400 }));
    await expect(client().generate({ system: "s", parts: [{ text: "x" }], schema })).rejects.toMatchObject({ retryable: false });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe("GeminiClient.embed", () => {
  it("batches by 100 and returns unit vectors", async () => {
    embedContent.mockImplementation(async ({ contents }: { contents: string[] }) => ({
      embeddings: contents.map(() => ({ values: [3, 4, 0] })),
    }));
    const vectors = await client().embed(Array.from({ length: 150 }, (_, i) => `t${i}`), "RETRIEVAL_DOCUMENT");
    expect(embedContent).toHaveBeenCalledTimes(2);
    expect(vectors).toHaveLength(150);
    expect(vectors[0]).toEqual([0.6, 0.8, 0]);
    expect(embedContent.mock.calls[0]![0].config).toEqual({ taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 3 });
  });
});

describe("helpers", () => {
  it("normalizes vectors and strips meta keys from the schema", () => {
    expect(normalize([0, 0])).toEqual([0, 0]);
    expect(toGeminiSchema(schema)).not.toHaveProperty("$schema");
  });

  it("fails clearly when no key is configured", async () => {
    await expect(new DisabledLlm().generate()).rejects.toThrow(/GEMINI_API_KEY/);
  });
});

describe("tracedGenerate", () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    handle = await createTestDatabase();
  });
  afterAll(async () => {
    await handle.close();
  });

  it("records successful and failed runs without storing media", async () => {
    generateContent.mockResolvedValueOnce(reply('{"summary":"ok","workers":2}'));
    await tracedGenerate(handle.db, client(), { agent: "site", trigger: "test" }, {
      system: "s",
      parts: [{ text: "report" }, { inlineData: { mimeType: "image/jpeg", data: "QUJDRA==" } }],
      schema,
    });
    generateContent.mockRejectedValueOnce(new ApiError({ message: "bad", status: 400 }));
    await expect(
      tracedGenerate(handle.db, client(), { agent: "site", trigger: "test" }, { system: "s", parts: [{ text: "x" }], schema }),
    ).rejects.toThrow();

    const runs = await handle.db.select().from(agentRuns);
    expect(runs.map((r) => r.status).sort()).toEqual(["error", "ok"]);
    const ok = runs.find((r) => r.status === "ok")!;
    expect(ok.input).toEqual([{ text: "report" }, { media: "image/jpeg", bytes: 6 }]);
    expect(ok).toMatchObject({ inputTokens: 10, outputTokens: 5, model: "gemini-test" });
  });
});
