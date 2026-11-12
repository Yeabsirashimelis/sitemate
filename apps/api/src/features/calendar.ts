/**
 * Keeps the company's Google Calendar in step with each project: the
 * three-week look-ahead, order-by dates, delay notice deadlines, RFI answers
 * due and the handover dates. Every event is tracked in calendar_events, so a
 * sync only sends what changed and removes what no longer applies.
 */

import { createHash } from "node:crypto";
import { addCalendarDays } from "@sitemate/engine";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit.js";
import { calendarEvents, claimEvents, projects, rfis } from "../db/schema.js";
import { longDate, plural } from "../domain/format.js";
import { localDate } from "../domain/time.js";
import type { CalendarEvent } from "../integrations/google-calendar.js";
import { EVENTS } from "../events.js";
import { enqueue } from "../jobs/queue.js";
import { buildLookahead } from "../services/lookahead.js";
import { forecastMaterials } from "../services/materials.js";
import { latestSnapshot, type Project } from "../services/schedule.js";
import type { FeatureDeps } from "./types.js";

export const CALENDAR_SYNC_JOB = "calendar.sync";
export const CALENDAR_AGENT = "calendar";

/** Google event colours. */
const COLOR = { blocked: "11", atRisk: "5", critical: "9", other: "8", deadline: "6", urgent: "11", handover: "3" } as const;

export function registerCalendarFeature(deps: FeatureDeps): void {
  if (!deps.calendar) return;
  deps.scheduler.add("calendar.hourly-sync", () => queueCalendarSyncs(deps));
  deps.runner.register(CALENDAR_SYNC_JOB, {
    schema: z.object({ projectId: z.uuid() }),
    handle: async ({ projectId }) => {
      await syncProjectCalendar(deps, projectId);
    },
  });
  // A site report moves the look-ahead, so the calendar follows it straight away.
  deps.events.subscribe(EVENTS.dailyLogCompleted, "calendar", z.object({ dailyLogId: z.uuid(), projectId: z.uuid() }), async ({ projectId }) => {
    await syncProjectCalendar(deps, projectId);
  });
}

/** Queues one sync per active project per hour. */
export async function queueCalendarSyncs(deps: FeatureDeps): Promise<number> {
  const hour = deps.now().toISOString().slice(0, 13);
  const active = await deps.db.select({ id: projects.id }).from(projects).where(eq(projects.active, true));
  let queued = 0;
  for (const project of active) {
    if ((await enqueue(deps.db, CALENDAR_SYNC_JOB, { projectId: project.id }, { idempotencyKey: `calendar:${project.id}:${hour}` })) !== null) queued++;
  }
  return queued;
}

export interface SyncResult {
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
}

export async function syncProjectCalendar(deps: FeatureDeps, projectId: string): Promise<SyncResult | null> {
  const { db, calendar } = deps;
  if (!calendar) return null;
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return null;

  const wanted = project.active ? await desiredEvents(deps, project) : new Map<string, CalendarEvent>();
  const existing = new Map((await db.select().from(calendarEvents).where(eq(calendarEvents.projectId, projectId))).map((row) => [row.key, row]));
  const result: SyncResult = { created: 0, updated: 0, removed: 0, unchanged: 0 };

  for (const [key, event] of wanted) {
    const hash = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    const row = existing.get(key);
    if (row?.contentHash === hash) {
      result.unchanged++;
      continue;
    }
    const googleEventId = row?.googleEventId ?? eventId(projectId, key);
    await calendar.upsert(googleEventId, event);
    await db
      .insert(calendarEvents)
      .values({ projectId, key, googleEventId, contentHash: hash, syncedAt: deps.now() })
      .onConflictDoUpdate({ target: [calendarEvents.projectId, calendarEvents.key], set: { contentHash: hash, syncedAt: deps.now() } });
    if (row) result.updated++;
    else result.created++;
  }

  for (const [key, row] of existing) {
    if (wanted.has(key)) continue;
    await calendar.remove(row.googleEventId);
    await db.delete(calendarEvents).where(eq(calendarEvents.id, row.id));
    result.removed++;
  }

  if (result.created || result.updated || result.removed) {
    await audit(db, {
      companyId: project.companyId,
      projectId,
      actor: { type: "agent", id: CALENDAR_AGENT },
      action: "calendar.synced",
      reason: [
        result.created ? `${plural(result.created, "event")} added` : null,
        result.updated ? `${plural(result.updated, "event")} moved or renamed` : null,
        result.removed ? `${plural(result.removed, "event")} removed` : null,
      ]
        .filter(Boolean)
        .join(", "),
      data: result,
    });
  }
  return result;
}

/**
 * Google event ids allow the letters a to v and digits, so a hex hash fits.
 * The id is fixed per project and key, which makes a retried create harmless.
 */
export function eventId(projectId: string, key: string): string {
  return `sm${createHash("sha256").update(`${projectId}:${key}`).digest("hex").slice(0, 40)}`;
}

const allDay = (date: string, through = date) => ({ start: date, end: addCalendarDays(through, 1) });

export async function desiredEvents(deps: FeatureDeps, project: Project): Promise<Map<string, CalendarEvent>> {
  const { db } = deps;
  const events = new Map<string, CalendarEvent>();
  const tag = `(${project.name})`;
  const today = localDate(deps.now(), deps.config.SITE_TIME_ZONE);

  // Handover: what the contract says and where the schedule now lands.
  events.set("contract-finish", {
    summary: `Contract completion ${tag}`,
    description: `Completion date in the contract for ${project.name}.`,
    ...allDay(project.contractFinish),
    colorId: COLOR.handover,
  });
  const snapshot = await latestSnapshot(db, project.id);
  if (snapshot && snapshot.finishDate !== project.contractFinish) {
    const late = snapshot.slipDays > 0;
    events.set("forecast-finish", {
      summary: `Forecast handover ${tag}`,
      description: `The schedule as of ${longDate(snapshot.dataDate)} finishes ${plural(Math.abs(snapshot.slipDays), "workday")} ${late ? "after" : "before"} the contract date of ${longDate(project.contractFinish)}.`,
      ...allDay(snapshot.finishDate),
      colorId: late ? COLOR.urgent : COLOR.handover,
    });
  }

  // Three-week look-ahead.
  const lookahead = await buildLookahead(db, project.id);
  for (const item of lookahead.items) {
    const notes = [
      item.critical ? "On the critical path: any slip here moves the handover." : `${plural(item.totalFloat, "workday")} of float.`,
      item.readiness === "ready" ? "Ready to start." : `${item.readiness === "blocked" ? "Blocked" : "At risk"}:`,
      ...item.constraints.map((c) => `- ${c.description}`),
    ];
    events.set(`activity:${item.code}`, {
      summary: `${item.readiness === "blocked" ? "Blocked: " : item.readiness === "at_risk" ? "At risk: " : ""}${item.code} ${item.name} ${tag}`,
      description: notes.join("\n"),
      ...allDay(item.startDate, item.finishDate),
      colorId: item.readiness === "blocked" ? COLOR.blocked : item.readiness === "at_risk" ? COLOR.atRisk : item.critical ? COLOR.critical : COLOR.other,
    });
  }

  // Order-by dates for materials that are not already on request.
  for (const forecast of await forecastMaterials(db, project.id)) {
    if (!forecast.orderBy || forecast.openOrderQuantity > 0 || forecast.status === "no_usage_data") continue;
    if (forecast.orderBy > addCalendarDays(today, 21)) continue;
    const { material } = forecast;
    events.set(`order:${material.id}`, {
      summary: `Order ${material.name.toLowerCase()} ${tag}`,
      description: `Last day to order ${material.name.toLowerCase()} so it arrives before stock runs out${forecast.runOutDate ? ` on ${longDate(forecast.runOutDate)}` : ""}. Supplier lead time is ${plural(material.leadTimeDays, "day")}.`,
      ...allDay(forecast.orderBy < today ? today : forecast.orderBy),
      colorId: forecast.status === "order_now" ? COLOR.urgent : COLOR.deadline,
    });
  }

  // The contract notice period for every delay still open.
  const openClaims = await db
    .select()
    .from(claimEvents)
    .where(and(eq(claimEvents.projectId, project.id), eq(claimEvents.status, "open")));
  for (const claim of openClaims) {
    const deadline = addCalendarDays(claim.startedOn, deps.config.CLAIM_NOTICE_DAYS);
    events.set(`notice:${claim.id}`, {
      summary: `Delay notice due: ${claim.title} ${tag}`,
      description: `The delay started ${longDate(claim.startedOn)}. Notice has to reach the engineer within ${plural(deps.config.CLAIM_NOTICE_DAYS, "day")}${claim.clauseRefs.length ? ` (clause ${claim.clauseRefs.join(", ")})` : ""}, or the right to extra time can be lost.`,
      ...allDay(deadline),
      colorId: COLOR.urgent,
    });
  }

  // Answers the consultant owes.
  const waiting = await db
    .select()
    .from(rfis)
    .where(and(eq(rfis.projectId, project.id), inArray(rfis.status, ["sent"])));
  for (const rfi of waiting) {
    events.set(`rfi:${rfi.id}`, {
      summary: `RFI ${rfi.number} answer due ${tag}`,
      description: `Sent ${longDate(rfi.raisedOn)}: ${rfi.question}`,
      ...allDay(rfi.dueOn),
      colorId: COLOR.deadline,
    });
  }

  return events;
}
