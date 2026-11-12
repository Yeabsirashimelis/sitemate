/**
 * Checks the Gemini settings in .env with one structured call and one
 * embedding call, so a bad key or model name shows up before the agents run.
 *
 *   pnpm --filter @sitemate/api check:gemini
 */

import { z } from "zod";
import { GeminiClient } from "../src/ai/llm.js";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { EMBEDDING_DIMENSIONS } from "../src/db/schema.js";

loadEnvFile();
const config = loadConfig();
if (!config.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is not set in .env");
  process.exit(1);
}

const client = new GeminiClient({
  apiKey: config.GEMINI_API_KEY,
  model: config.GEMINI_MODEL,
  fallbackModel: config.GEMINI_FALLBACK_MODEL || undefined,
  embeddingModel: config.GEMINI_EMBEDDING_MODEL,
  embeddingDimensions: EMBEDDING_DIMENSIONS,
  maxAttempts: 2,
});

try {
  const started = Date.now();
  const { value, usage, model } = await client.generate({
    system: "You read site reports from building supervisors. Respond with JSON only.",
    parts: [{ text: "ዛሬ 8 ግንበኞች እና 12 የቀን ሰራተኞች ነበሩ። 40 ኩንታል ሲሚንቶ ተጠቅመናል።" }],
    schema: z.object({
      workers: z.array(z.object({ trade: z.string(), count: z.number().int() })),
      cementBags: z.number().nullable(),
    }),
  });
  console.log(`${model} answered in ${Date.now() - started} ms (${usage.inputTokens} in, ${usage.outputTokens} out):`);
  console.log(JSON.stringify(value));

  const [vector] = await client.embed(["Concrete for columns shall be grade C25"], "RETRIEVAL_DOCUMENT");
  console.log(`Embedding model ${config.GEMINI_EMBEDDING_MODEL} returned ${vector?.length} dimensions.`);
} catch (error) {
  console.error("Gemini check failed:", error instanceof Error ? error.message : error);
  process.exit(1);
}
