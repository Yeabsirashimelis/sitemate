/**
 * Three week look ahead.
 *
 * Every activity planned to start or continue in the next three weeks is
 * checked against what it needs: finished predecessors, material in stock,
 * answers to open questions, and weather. Anything missing is a constraint
 * with someone who has to act, found weeks before the crew arrives.
 */

import { computeSchedule } from "@sitemate/engine";
import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/client.js";
import { activityLinks, rfis, weatherForecasts } from "../db/schema.js";
import { longDate } from "../domain/format.js";
import { weatherRisk } from "../domain/weather-rules.js";
import { consumes, forecastMaterials } from "./materials.js";
import { loadProjectSchedule } from "./schedule.js";

export const LOOKAHEAD_WORKDAYS = 18;

export type Readiness = "ready" | "at_risk" | "blocked";

export interface Constraint {
  kind: "predecessor" | "material" | "information" | "weather";
  description: string;
  severity: "warning" | "blocking";
}

export interface LookaheadItem {
  code: string;
  name: string;
  zone: string | null;
  startDate: string;
  finishDate: string;
  status: "not_started" | "in_progress";
  critical: boolean;
  totalFloat: number;
  readiness: Readiness;
  constraints: Constraint[];
}

export async function buildLookahead(db: Executor, projectId: string) {
  const schedule = await loadProjectSchedule(db, projectId);
  const { calendar, project } = schedule;
  if (schedule.activities.length === 0) return { from: project.dataDate, to: project.dataDate, items: [] as LookaheadItem[] };

  const result = computeSchedule(schedule.activities, calendar, { dataDate: project.dataDate });
  const start = calendar.indexOf(project.dataDate);
  const end = start + LOOKAHEAD_WORKDAYS;

  const links = await db.select().from(activityLinks).where(eq(activityLinks.projectId, projectId));
  const codeById = new Map([...schedule.byCode.values()].map((a) => [a.id, a.code]));
  const openRfis = await db
    .select()
    .from(rfis)
    .where(and(eq(rfis.projectId, projectId), inArray(rfis.status, ["draft", "pending_approval", "sent"])));
  const forecasts = await db.select().from(weatherForecasts).where(eq(weatherForecasts.projectId, projectId));
  const forecastByDate = new Map(forecasts.map((f) => [f.date, f]));
  const materialForecasts = await forecastMaterials(db, projectId);

  const items: LookaheadItem[] = [];
  for (const code of result.order) {
    const planned = result.activities.get(code)!;
    const row = schedule.byCode.get(code)!;
    if (planned.status === "complete" || planned.earlyStart >= end || planned.earlyFinish <= start) continue;
    const constraints: Constraint[] = [];

    for (const link of links.filter((l) => l.toActivityId === row.id)) {
      const predecessorCode = codeById.get(link.fromActivityId)!;
      const predecessor = result.activities.get(predecessorCode)!;
      if (planned.status === "not_started" && predecessor.status !== "complete" && link.type === "FS") {
        constraints.push({
          kind: "predecessor",
          description: `Waiting for ${predecessorCode} ${predecessor.name}, forecast to finish ${longDate(predecessor.finishDate)}`,
          severity: "warning",
        });
      }
    }

    for (const forecast of materialForecasts) {
      if (!forecast.runOutDate || !consumes(forecast.material, row)) continue;
      if (forecast.runOutDate <= planned.finishDate) {
        const covered = forecast.openOrderQuantity > 0;
        constraints.push({
          kind: "material",
          description: `${forecast.material.name} runs out ${longDate(forecast.runOutDate)}${covered ? ", an order is open" : ", nothing ordered yet"}`,
          severity: covered ? "warning" : "blocking",
        });
      }
    }

    for (const rfi of openRfis.filter((r) => r.activityId === row.id)) {
      constraints.push({
        kind: "information",
        description: `Waiting for an answer to RFI ${rfi.number}, due ${longDate(rfi.dueOn)}: ${rfi.question}`,
        severity: "blocking",
      });
    }

    for (let index = Math.max(planned.earlyStart, start); index < planned.earlyFinish; index++) {
      const date = calendar.dateOf(index);
      const day = forecastByDate.get(date);
      const risk = day ? weatherRisk(row.kind, day) : null;
      if (risk) {
        constraints.push({ kind: "weather", description: `${risk} forecast on ${longDate(date)}`, severity: "warning" });
        break;
      }
    }

    items.push({
      code,
      name: row.name,
      zone: row.zone,
      startDate: planned.startDate,
      finishDate: planned.finishDate,
      status: planned.status as "not_started" | "in_progress",
      critical: planned.critical,
      totalFloat: planned.totalFloat,
      readiness: constraints.some((c) => c.severity === "blocking") ? "blocked" : constraints.length > 0 ? "at_risk" : "ready",
      constraints,
    });
  }

  return { from: project.dataDate, to: calendar.dateOf(end - 1), items };
}
