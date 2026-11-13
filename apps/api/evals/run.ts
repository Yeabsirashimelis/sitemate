/**
 * Runs the evaluation cases against the real model, through the same prompt,
 * schema and checks the live system uses, and writes evals/RESULTS.md.
 *
 *   pnpm --filter @sitemate/api eval
 */

import { writeFileSync } from "node:fs";
import { GeminiClient, type LlmClient } from "../src/ai/llm.js";
import { quotePrompt, quoteSchema } from "../src/agents/quote-agent.js";
import { checkExtraction, contextText, extractionSchema, systemPrompt, type CheckedLog } from "../src/agents/site-agent.js";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { EMBEDDING_DIMENSIONS } from "../src/db/schema.js";
import { quoteCases, siteCases, siteContext, type QuoteCase, type SiteCase } from "./cases.js";

loadEnvFile();
const config = loadConfig();
if (!config.GEMINI_API_KEY) throw new Error("Set GEMINI_API_KEY in apps/api/.env to run the evals");

const llm: LlmClient = new GeminiClient({
  apiKey: config.GEMINI_API_KEY,
  model: config.GEMINI_MODEL,
  fallbackModel: config.GEMINI_FALLBACK_MODEL || undefined,
  embeddingModel: config.GEMINI_EMBEDDING_MODEL,
  embeddingDimensions: EMBEDDING_DIMENSIONS,
});

const PERCENT_TOLERANCE = 10;
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.01);
const key = (name: string) => name.trim().toLowerCase();

interface Check {
  field: string;
  ok: boolean;
  detail?: string;
}

interface Outcome {
  id: string;
  group: string;
  checks: Check[];
  model: string;
  ms: number;
  retries?: number;
  error?: string;
}

function materialsCheck(field: string, expected: Record<string, number> = {}, got: CheckedLog["materialsUsed"]): Check {
  const want = new Map(Object.entries(expected).map(([name, quantity]) => [key(name), quantity]));
  const have = new Map<string, number>();
  for (const m of got) have.set(key(m.material), (have.get(key(m.material)) ?? 0) + m.quantity);
  const wrong = [...want].filter(([name, quantity]) => !have.has(name) || !near(have.get(name)!, quantity));
  const extra = [...have.keys()].filter((name) => !want.has(name));
  const ok = wrong.length === 0 && extra.length === 0;
  return { field, ok, ...(ok ? {} : { detail: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(Object.fromEntries(have))}` }) };
}

function scoreSite(c: SiteCase, log: CheckedLog): Check[] {
  const checks: Check[] = [];
  const workers = log.workers.reduce((sum, w) => sum + w.count, 0);
  checks.push({ field: "Worker count", ok: workers === c.expect.workers, ...(workers === c.expect.workers ? {} : { detail: `expected ${c.expect.workers}, got ${workers}` }) });

  const expectedCodes = Object.keys(c.expect.progress).sort();
  const gotProgress = new Map(log.progress.map((p) => [p.activityCode, p.percentComplete]));
  const gotCodes = [...gotProgress.keys()].sort();
  const sameActivities = expectedCodes.join() === gotCodes.join();
  checks.push({ field: "Right activities", ok: sameActivities, ...(sameActivities ? {} : { detail: `expected [${expectedCodes}], got [${gotCodes}]` }) });

  if (expectedCodes.length) {
    const off = expectedCodes.filter((code) => !gotProgress.has(code) || Math.abs(gotProgress.get(code)! - c.expect.progress[code]!) > PERCENT_TOLERANCE);
    checks.push({
      field: "Percent complete",
      ok: off.length === 0,
      ...(off.length ? { detail: off.map((code) => `${code} expected ${c.expect.progress[code]}, got ${gotProgress.get(code) ?? "nothing"}`).join("; ") } : {}),
    });
  }

  checks.push(materialsCheck("Materials used", c.expect.used, log.materialsUsed));
  checks.push(materialsCheck("Materials received", c.expect.received, log.materialsReceived));

  if (c.expect.issues?.length) {
    const kinds = new Set(log.issues.map((i) => i.kind));
    const missed = c.expect.issues.filter((any) => !any.some((kind) => kinds.has(kind)));
    checks.push({ field: "Problems flagged", ok: missed.length === 0, ...(missed.length ? { detail: `expected ${missed.map((m) => m.join(" or ")).join(", ")}, got [${[...kinds]}]` } : {}) });
  }
  return checks;
}

function scoreQuote(c: QuoteCase, q: { isQuote: boolean; unitPrice: number | null; currency: string; leadTimeDays: number | null; reference: string | null }): Check[] {
  const checks: Check[] = [{ field: "Is it a price", ok: q.isQuote === c.expect.isQuote, ...(q.isQuote === c.expect.isQuote ? {} : { detail: `expected ${c.expect.isQuote}` }) }];
  if (!c.expect.isQuote) return checks;
  const priceOk = q.unitPrice !== null && near(q.unitPrice, c.expect.unitPrice!);
  checks.push({ field: "Price", ok: priceOk, ...(priceOk ? {} : { detail: `expected ${c.expect.unitPrice}, got ${q.unitPrice}` }) });
  const currencyOk = q.currency.toUpperCase() === c.expect.currency;
  checks.push({ field: "Currency", ok: currencyOk, ...(currencyOk ? {} : { detail: `expected ${c.expect.currency}, got ${q.currency}` }) });
  const lead = c.expect.leadTimeDays;
  const leadOk = Array.isArray(lead) ? q.leadTimeDays !== null && q.leadTimeDays >= lead[0] && q.leadTimeDays <= lead[1] : q.leadTimeDays === lead;
  checks.push({ field: "Delivery days", ok: leadOk, ...(leadOk ? {} : { detail: `expected ${JSON.stringify(lead)}, got ${q.leadTimeDays}` }) });
  if (c.expect.reference) {
    const refOk = q.reference?.toUpperCase() === c.expect.reference;
    checks.push({ field: "Reference", ok: refOk, ...(refOk ? {} : { detail: `expected ${c.expect.reference}, got ${q.reference}` }) });
  }
  return checks;
}

/**
 * In production a call the model does not answer is retried by the job queue.
 * Do the same here, so the score is about reading, not about a busy API.
 */
async function withRetry<T>(call: () => Promise<T>): Promise<{ value: T; retries: number }> {
  for (let retries = 0; ; retries++) {
    try {
      return { value: await call(), retries };
    } catch (error) {
      if (retries >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
  }
}

async function runSite(c: SiteCase): Promise<Outcome> {
  const context = siteContext(c.language);
  const started = Date.now();
  try {
    const { value: result, retries } = await withRetry(() =>
      llm.generate({
        system: systemPrompt(context),
        parts: [{ text: contextText(context) }, { text: `[17:40] Text: ${c.text}` }],
        schema: extractionSchema,
      }),
    );
    return { id: c.id, group: c.group, checks: scoreSite(c, checkExtraction(result.value, context)), model: result.model, ms: Date.now() - started, retries };
  } catch (error) {
    return { id: c.id, group: c.group, checks: [{ field: "Answered", ok: false }], model: "-", ms: Date.now() - started, error: String(error).slice(0, 200) };
  }
}

async function runQuote(c: QuoteCase): Promise<Outcome> {
  const started = Date.now();
  try {
    const { value: result, retries } = await withRetry(() => llm.generate({
      system: quotePrompt({ supplier: "Derba Building Materials", open: [{ reference: "PR-1A2B3C4D", material: c.material.name, quantity: c.material.quantity, unit: c.material.unit }] }),
      parts: [{ text: c.text }],
      schema: quoteSchema,
    }));
    return { id: c.id, group: "Supplier prices", checks: scoreQuote(c, result.value), model: result.model, ms: Date.now() - started, retries };
  } catch (error) {
    return { id: c.id, group: "Supplier prices", checks: [{ field: "Answered", ok: false }], model: "-", ms: Date.now() - started, error: String(error).slice(0, 200) };
  }
}

/** A few at a time, so a busy model is not flooded. */
async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(run))));
    process.stdout.write(`  ${Math.min(i + size, items.length)}/${items.length}\r`);
  }
  process.stdout.write("\n");
  return results;
}

const pct = (ok: number, total: number) => (total ? `${Math.round((ok / total) * 100)}%` : "-");

function table(outcomes: Outcome[], groups: string[]): string {
  const fields = [...new Set(outcomes.flatMap((o) => o.checks.map((c) => c.field)))];
  const rows = [
    `| | ${fields.join(" | ")} | All correct |`,
    `|---|${fields.map(() => "---:").join("|")}|---:|`,
    ...groups.map((group) => {
      const set = outcomes.filter((o) => o.group === group);
      const cells = fields.map((field) => {
        const checks = set.flatMap((o) => o.checks.filter((c) => c.field === field));
        return checks.length ? `${checks.filter((c) => c.ok).length}/${checks.length}` : "";
      });
      return `| ${group} (${set.length}) | ${cells.join(" | ")} | ${set.filter((o) => o.checks.every((c) => c.ok)).length}/${set.length} |`;
    }),
  ];
  const totals = fields.map((field) => {
    const checks = outcomes.flatMap((o) => o.checks.filter((c) => c.field === field));
    return `**${pct(checks.filter((c) => c.ok).length, checks.length)}**`;
  });
  rows.push(`| **Overall** | ${totals.join(" | ")} | **${pct(outcomes.filter((o) => o.checks.every((c) => c.ok)).length, outcomes.length)}** |`);
  return rows.join("\n");
}

function failures(outcomes: Outcome[]): string {
  const lines = outcomes.flatMap((o) =>
    o.error ? [`- \`${o.id}\` no answer: ${o.error}`] : o.checks.filter((c) => !c.ok).map((c) => `- \`${o.id}\` ${c.field.toLowerCase()}: ${c.detail ?? "wrong"}`),
  );
  return lines.length ? lines.join("\n") : "None.";
}

console.log(`Site reports (${siteCases.length})`);
const site = await inBatches(siteCases, 3, runSite);
console.log(`Supplier prices (${quoteCases.length})`);
const quotes = await inBatches(quoteCases, 3, runQuote);

const all = [...site, ...quotes];
const models = [...new Set(all.map((o) => o.model).filter((m) => m !== "-"))];
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const date = new Date().toISOString().slice(0, 10);

const report = `# Evaluation results

Run on ${date} against ${models.join(" and ") || "no model"} (${all.filter((o) => o.model === config.GEMINI_FALLBACK_MODEL).length} of ${all.length} answers came from the backup model because the main one was busy). Median time per answer: ${(median(all.map((o) => o.ms)) / 1000).toFixed(1)} s. ${all.filter((o) => o.retries).length} calls got no answer at first and were retried, as the job queue does in production.

Each case is a message written the way a supervisor or supplier actually sends it, with the answer a careful project engineer would take from it. The model's output goes through the same checks as in production before it is scored. Progress counts as right within ${PERCENT_TOLERANCE} percentage points; worker counts and quantities have to match.

## Site reports

${table(site, ["English", "English, informal", "Amharic", "Amharic and English mixed", "Hard cases"])}

## Supplier prices

${table(quotes, ["Supplier prices"])}

## What it got wrong

${failures(all)}

Cases are in \`evals/cases.ts\`. Run again with \`pnpm --filter @sitemate/api eval\`.
`;

writeFileSync(new URL("./RESULTS.md", import.meta.url), report);
console.log(report);
