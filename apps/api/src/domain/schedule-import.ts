/**
 * Schedule import.
 *
 * Contractors keep schedules in Excel or MS Project. Both can save CSV, so
 * CSV is the main import format, with one row per activity:
 *
 *   code,name,duration,predecessors,kind,zone,progress_unit,planned_quantity
 *   A1010,Excavation,5,,excavation,Block A,m3,420
 *   A1020,Footings,6,A1010,concrete_pour,Block A,m3,85
 *   A1030,Column starters,3,A1020SS+2,general,Block A,,
 *
 * Predecessors are separated by ";" and written as CODE, optionally
 * followed by a link type (FS, SS, FF, SF) and a lag in workdays: A1020SS+2.
 */

import { z } from "zod";
import { activityKind } from "../db/schema.js";

export const importedActivity = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9._-]+$/, "Activity codes may use letters, digits, dot, dash and underscore"),
  name: z.string().trim().min(1).max(200),
  duration: z.coerce.number().int().min(0).max(2000),
  kind: z.enum(activityKind.enumValues).default("general"),
  zone: z.string().trim().max(80).optional(),
  progressUnit: z.string().trim().max(20).optional(),
  plannedQuantity: z.coerce.number().nonnegative().optional(),
  predecessors: z
    .array(
      z.object({
        code: z.string().trim().min(1),
        type: z.enum(["FS", "SS", "FF", "SF"]).default("FS"),
        lag: z.number().int().min(-365).max(365).default(0),
      }),
    )
    .default([]),
});

export type ImportedActivity = z.infer<typeof importedActivity>;

export class ImportError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = "ImportError";
  }
}

const PREDECESSOR = /^([A-Za-z0-9._-]+?)(FS|SS|FF|SF)?([+-]\d+)?$/i;

export function parsePredecessors(text: string): ImportedActivity["predecessors"] {
  return text
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = PREDECESSOR.exec(part.replace(/\s+/g, ""));
      if (!match) throw new Error(`Cannot read predecessor "${part}"`);
      const [, code, type, lag] = match;
      return {
        code: code!,
        type: (type?.toUpperCase() ?? "FS") as "FS" | "SS" | "FF" | "SF",
        lag: lag ? Number(lag) : 0,
      };
    });
}

/** Splits one CSV line, honouring double quotes. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

const HEADER_ALIASES: Record<string, string> = {
  id: "code",
  activity_id: "code",
  "activity id": "code",
  activity: "name",
  "activity name": "name",
  description: "name",
  dur: "duration",
  "duration (days)": "duration",
  predecessor: "predecessors",
  type: "kind",
  location: "zone",
  unit: "progress_unit",
  quantity: "planned_quantity",
};

export function parseScheduleCsv(csv: string): ImportedActivity[] {
  const lines = csv
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new ImportError("The file has no activities", ["Expected a header row and at least one activity"]);

  const headers = splitCsvLine(lines[0]!).map((h) => {
    const key = h.toLowerCase().trim();
    return HEADER_ALIASES[key] ?? key.replace(/\s+/g, "_");
  });
  for (const required of ["code", "name", "duration"]) {
    if (!headers.includes(required)) {
      throw new ImportError("The header row is missing columns", [`Missing column "${required}"`]);
    }
  }

  const problems: string[] = [];
  const activities: ImportedActivity[] = [];
  lines.slice(1).forEach((line, index) => {
    const row = index + 2;
    const cells = splitCsvLine(line);
    const value = (name: string) => {
      const cell = cells[headers.indexOf(name)];
      return cell === undefined || cell === "" ? undefined : cell;
    };
    try {
      const parsed = importedActivity.safeParse({
        code: value("code"),
        name: value("name"),
        duration: value("duration"),
        kind: value("kind")?.toLowerCase(),
        zone: value("zone"),
        progressUnit: value("progress_unit"),
        plannedQuantity: value("planned_quantity"),
        predecessors: parsePredecessors(value("predecessors") ?? ""),
      });
      if (parsed.success) {
        activities.push(parsed.data);
      } else {
        for (const issue of parsed.error.issues) problems.push(`Row ${row}, ${issue.path.join(".")}: ${issue.message}`);
      }
    } catch (error) {
      problems.push(`Row ${row}: ${(error as Error).message}`);
    }
  });

  if (problems.length > 0) throw new ImportError("Some rows could not be read", problems);
  return activities;
}

/** Checks codes are unique and every predecessor exists. Loops are caught by the scheduling engine. */
export function validateImport(activities: readonly ImportedActivity[]): void {
  const problems: string[] = [];
  const codes = new Set<string>();
  for (const activity of activities) {
    if (codes.has(activity.code)) problems.push(`Activity code ${activity.code} is used more than once`);
    codes.add(activity.code);
  }
  for (const activity of activities) {
    for (const link of activity.predecessors) {
      if (!codes.has(link.code)) problems.push(`${activity.code} depends on ${link.code}, which is not in the schedule`);
      if (link.code === activity.code) problems.push(`${activity.code} depends on itself`);
    }
  }
  if (activities.length === 0) problems.push("The schedule has no activities");
  if (problems.length > 0) throw new ImportError("The schedule logic has problems", problems);
}
