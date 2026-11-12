/**
 * Site agent: turns what a supervisor sends (typed notes, Amharic or English
 * voice notes, photos) into a structured daily log.
 *
 * The model only reads and structures. It is told which activities and
 * materials exist, and everything it returns is checked in code before it
 * touches the schedule or the stock.
 */

import { z } from "zod";
import type { LogIssue, LogMaterial, LogProgress, LogWorkers } from "../db/schema.js";

export const SITE_AGENT = "site";

const severity = z.enum(["low", "medium", "high"]);

export const extractionSchema = z.object({
  summary: z.string().describe("Two or three plain sentences in English describing the day on site."),
  weather: z.string().nullable().describe("Weather on site if mentioned or visible, otherwise null."),
  workers: z
    .array(z.object({ trade: z.string(), count: z.number().int().min(0).max(1000) }))
    .describe("Workers on site by trade, only if reported."),
  progress: z
    .array(
      z.object({
        activityCode: z.string().describe("Code from the activity list. Never invent a code."),
        percentComplete: z.number().min(0).max(100).describe("Cumulative percent complete at the end of today."),
        quantityDone: z.number().min(0).nullable().describe("Quantity done today in the activity's unit, if reported."),
        note: z.string().nullable(),
      }),
    )
    .describe("Only activities the supervisor actually reported on."),
  materialsReceived: z.array(z.object({ material: z.string(), quantity: z.number().min(0), unit: z.string() })),
  materialsUsed: z.array(z.object({ material: z.string(), quantity: z.number().min(0), unit: z.string() })),
  issues: z.array(
    z.object({
      kind: z.enum(["delay", "safety", "quality", "material", "weather", "information", "other"]),
      description: z.string(),
      activityCode: z.string().nullable(),
      severity,
      delayDays: z.number().int().min(0).max(365).nullable().describe("Workdays lost or expected to be lost, if stated."),
    }),
  ),
  photoChecks: z
    .array(
      z.object({
        description: z.string().describe("What the photo shows."),
        matchesReport: z.boolean().describe("False if the photo clearly contradicts the reported progress."),
        concern: z.string().nullable().describe("A clear safety or quality problem visible in the photo, else null."),
      }),
    )
    .describe("One entry per photo, in the order received."),
  missing: z.array(z.string()).describe("Important facts still missing for a complete log."),
  followUpQuestion: z
    .string()
    .nullable()
    .describe("One short question to the supervisor, in their language, about the most important missing fact. Null if the log is complete enough."),
  confidence: z.number().min(0).max(1).describe("How sure you are that the log is right."),
});

export type Extraction = z.infer<typeof extractionSchema>;

export interface SiteContext {
  projectName: string;
  logDate: string;
  supervisorName: string;
  language: "en" | "am";
  activities: Array<{ code: string; name: string; zone: string | null; unit: string | null; percentComplete: number }>;
  materials: Array<{ name: string; unit: string }>;
  previous: { summary: string | null; followUpQuestion: string | null } | null;
}

export function systemPrompt(context: SiteContext): string {
  const language = context.language === "am" ? "Amharic" : "English";
  return [
    "You are the site agent of SiteMate, working for a building contractor in Ethiopia.",
    "You read what a site supervisor sent today (typed text, voice notes in Amharic or English, and photos) and fill in the daily site log.",
    "",
    "Rules:",
    "- Use only facts the supervisor gave or that are clearly visible in a photo. Never guess numbers.",
    "- Map work to the activity codes in the list. If something does not match any activity, mention it in the summary instead.",
    "- percentComplete is the cumulative total at the end of today, not today's share. It is never lower than the current value unless the supervisor says work was undone.",
    "- Use the material names from the list when they match, otherwise the name the supervisor used.",
    "- A delay is anything that stopped or slowed planned work: late delivery, missing drawings, rain, no workers, broken equipment.",
    "- Photos are evidence. Flag a photo only when it clearly contradicts the report or shows a clear safety problem such as no helmets or an open edge without a guardrail.",
    "- Ask a follow-up question only if something important is missing, such as which activity was worked on, the number of workers, or how much was done. Ask about one thing.",
    `- Write followUpQuestion in ${language}, short and polite, the way a site coordinator would ask on Telegram. Everything else is in English.`,
    "",
    "Respond with JSON only.",
  ].join("\n");
}

export function contextText(context: SiteContext): string {
  const activities = context.activities
    .map((a) => `${a.code} | ${a.name}${a.zone ? ` | ${a.zone}` : ""}${a.unit ? ` | unit ${a.unit}` : ""} | now ${a.percentComplete}%`)
    .join("\n");
  const materials = context.materials.map((m) => `${m.name} (${m.unit})`).join(", ");
  return [
    `Project: ${context.projectName}`,
    `Date: ${context.logDate}`,
    `Supervisor: ${context.supervisorName}`,
    "",
    "Activities that are open (code | name | zone | unit | current progress):",
    activities || "(none)",
    "",
    `Materials tracked on site: ${materials || "(none)"}`,
    ...(context.previous?.followUpQuestion
      ? ["", `Earlier today you asked: "${context.previous.followUpQuestion}". The supervisor's reply is among the messages below.`]
      : []),
    "",
    "Messages from the supervisor today, in order:",
  ].join("\n");
}

export interface CheckedLog {
  summary: string;
  weather: string | null;
  workers: LogWorkers[];
  progress: LogProgress[];
  materialsReceived: LogMaterial[];
  materialsUsed: LogMaterial[];
  issues: LogIssue[];
  photoConcerns: string[];
  followUpQuestion: string | null;
  confidence: number;
  /** Things the code corrected or dropped, kept for the audit log. */
  corrections: string[];
}

/**
 * Checks the model's output against the project: unknown activity codes are
 * dropped, progress cannot fall below what is recorded, material names are
 * matched to tracked materials, and duplicates are merged.
 */
export function checkExtraction(extraction: Extraction, context: SiteContext): CheckedLog {
  const corrections: string[] = [];
  const activities = new Map(context.activities.map((a) => [a.code.toUpperCase(), a]));
  const materialNames = new Map(context.materials.map((m) => [m.name.toLowerCase(), m.name]));

  const progressByCode = new Map<string, LogProgress>();
  for (const item of extraction.progress) {
    const activity = activities.get(item.activityCode.trim().toUpperCase());
    if (!activity) {
      corrections.push(`Dropped progress for unknown activity ${item.activityCode}`);
      continue;
    }
    let percent = Math.round(item.percentComplete * 10) / 10;
    if (percent < activity.percentComplete) {
      corrections.push(`${activity.code}: kept ${activity.percentComplete}% instead of lower ${percent}%`);
      percent = activity.percentComplete;
    }
    progressByCode.set(activity.code, {
      activityCode: activity.code,
      percentComplete: percent,
      ...(item.quantityDone !== null ? { quantityDone: item.quantityDone } : {}),
      ...(item.note ? { note: item.note } : {}),
    });
  }

  const matchMaterial = (list: Extraction["materialsUsed"]): LogMaterial[] => {
    const merged = new Map<string, LogMaterial>();
    for (const item of list) {
      if (item.quantity <= 0) continue;
      const name = materialNames.get(item.material.trim().toLowerCase()) ?? item.material.trim();
      const existing = merged.get(name.toLowerCase());
      if (existing) existing.quantity += item.quantity;
      else merged.set(name.toLowerCase(), { material: name, quantity: item.quantity, unit: item.unit });
    }
    return [...merged.values()];
  };

  const workers = new Map<string, LogWorkers>();
  for (const w of extraction.workers) {
    const key = w.trade.trim().toLowerCase();
    if (!key || w.count === 0) continue;
    const existing = workers.get(key);
    if (existing) existing.count += w.count;
    else workers.set(key, { trade: w.trade.trim(), count: w.count });
  }

  const issues: LogIssue[] = extraction.issues.map((issue) => {
    const code = issue.activityCode ? activities.get(issue.activityCode.trim().toUpperCase())?.code : undefined;
    return {
      kind: issue.kind,
      description: issue.description,
      severity: issue.severity,
      ...(code ? { activityCode: code } : {}),
      ...(issue.delayDays !== null ? { delayDays: issue.delayDays } : {}),
    };
  });

  const photoConcerns = extraction.photoChecks.flatMap((check) => {
    const concerns: string[] = [];
    if (!check.matchesReport) concerns.push(`Photo does not match the report: ${check.description}`);
    if (check.concern) concerns.push(check.concern);
    return concerns;
  });
  for (const concern of photoConcerns) {
    issues.push({ kind: /helmet|guard|edge|harness|scaffold|safety/i.test(concern) ? "safety" : "quality", description: concern, severity: "medium" });
  }

  return {
    summary: extraction.summary.trim(),
    weather: extraction.weather,
    workers: [...workers.values()],
    progress: [...progressByCode.values()],
    materialsReceived: matchMaterial(extraction.materialsReceived),
    materialsUsed: matchMaterial(extraction.materialsUsed),
    issues,
    photoConcerns,
    followUpQuestion: extraction.followUpQuestion?.trim() || null,
    confidence: Math.round(extraction.confidence * 100) / 100,
    corrections,
  };
}
