/**
 * Bill of quantities import, one row per item:
 *
 *   item_no,description,unit,quantity,rate,activity_code
 *   3.1,"C25 concrete in footings",m3,40,9800,A20
 *
 * The activity code links the item to the schedule, which is how measured
 * progress turns into money for earned value and payment claims.
 */

import { z } from "zod";
import { ImportError } from "./schedule-import.js";

export const boqItem = z.object({
  itemNo: z.string().trim().min(1).max(30),
  description: z.string().trim().min(1).max(500),
  unit: z.string().trim().min(1).max(20),
  quantity: z.coerce.number().nonnegative(),
  rate: z.coerce.number().nonnegative(),
  activityCode: z.string().trim().min(1).optional(),
});

export type BoqItemInput = z.infer<typeof boqItem>;

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
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(current.trim());
      current = "";
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

const ALIASES: Record<string, string> = {
  item: "item_no",
  "item no": "item_no",
  no: "item_no",
  qty: "quantity",
  "unit rate": "rate",
  activity: "activity_code",
  "activity id": "activity_code",
};

export function parseBoqCsv(csv: string): BoqItemInput[] {
  const lines = csv
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (lines.length < 2) throw new ImportError("The file has no items", ["Expected a header row and at least one item"]);
  const headers = splitCsvLine(lines[0]!).map((h) => {
    const key = h.toLowerCase().trim();
    return ALIASES[key] ?? key.replace(/\s+/g, "_");
  });
  for (const required of ["item_no", "description", "unit", "quantity", "rate"]) {
    if (!headers.includes(required)) throw new ImportError("The header row is missing columns", [`Missing column "${required}"`]);
  }

  const problems: string[] = [];
  const items: BoqItemInput[] = [];
  lines.slice(1).forEach((line, index) => {
    const cells = splitCsvLine(line);
    const value = (name: string) => {
      const cell = cells[headers.indexOf(name)];
      return cell === undefined || cell === "" ? undefined : cell.replace(/,(?=\d{3}\b)/g, "");
    };
    const parsed = boqItem.safeParse({
      itemNo: value("item_no"),
      description: cells[headers.indexOf("description")],
      unit: value("unit"),
      quantity: value("quantity"),
      rate: value("rate"),
      activityCode: value("activity_code"),
    });
    if (parsed.success) items.push(parsed.data);
    else for (const issue of parsed.error.issues) problems.push(`Row ${index + 2}, ${issue.path.join(".")}: ${issue.message}`);
  });
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.itemNo)) problems.push(`Item ${item.itemNo} appears more than once`);
    seen.add(item.itemNo);
  }
  if (problems.length > 0) throw new ImportError("Some items could not be read", problems);
  return items;
}
