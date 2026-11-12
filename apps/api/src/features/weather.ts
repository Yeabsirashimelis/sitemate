/**
 * Morning weather check. Looks at the next few days for every site and, when
 * the forecast would stop weather-sensitive work that is planned then, works
 * out what holding that work back would do to the handover and asks the
 * project manager. Work already under way gets a warning instead.
 */

import { addCalendarDays, computeSchedule } from "@sitemate/engine";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit.js";
import { approvals, auditLog, projects, weatherForecasts } from "../db/schema.js";
import { longDate, plural } from "../domain/format.js";
import { localDate, localMinutes } from "../domain/time.js";
import { isWeatherSensitive, weatherRisk } from "../domain/weather-rules.js";
import type { DailyForecast } from "../integrations/open-meteo.js";
import { enqueue } from "../jobs/queue.js";
import { loadProjectSchedule } from "../services/schedule.js";
import { notifyProject } from "./notify.js";
import { SET_CONSTRAINT } from "./schedule.js";
import type { FeatureDeps } from "./types.js";

export const WEATHER_CHECK_JOB = "weather.check";
export const WEATHER_AGENT = "weather";

/** Days ahead the check looks at. Further out, forecasts are too uncertain to act on. */
const HORIZON_DAYS = 4;
/** Local time the morning check runs, in minutes after midnight (06:30). */
const MORNING_CHECK_MINUTES = 6 * 60 + 30;

export function registerWeatherFeature(deps: FeatureDeps): void {
  deps.scheduler.add("weather.morning-check", () => queueMorningWeatherChecks(deps));
  deps.runner.register(WEATHER_CHECK_JOB, {
    schema: z.object({ projectId: z.uuid() }),
    handle: async ({ projectId }) => {
      await checkWeather(deps, projectId);
    },
  });
}

export interface WeatherFinding {
  activityCode: string;
  date: string;
  risk: string;
  action: "proposed_hold" | "warned" | "skipped";
}

export async function checkWeather(deps: FeatureDeps, projectId: string): Promise<WeatherFinding[]> {
  const { db, config } = deps;
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project?.active || project.latitude === null || project.longitude === null) return [];

  const forecast = await deps.weather.forecast(project.latitude, project.longitude, 7, config.SITE_TIME_ZONE);
  for (const day of forecast) {
    await db
      .insert(weatherForecasts)
      .values({ projectId, ...day, fetchedAt: deps.now() })
      .onConflictDoUpdate({
        target: [weatherForecasts.projectId, weatherForecasts.date],
        set: { precipitationMm: day.precipitationMm, precipitationProbability: day.precipitationProbability, windKmh: day.windKmh, fetchedAt: deps.now() },
      });
  }

  const schedule = await loadProjectSchedule(db, projectId);
  if (schedule.activities.length === 0) return [];
  const { calendar } = schedule;
  const result = computeSchedule(schedule.activities, calendar, { dataDate: project.dataDate });

  const today = localDate(deps.now(), config.SITE_TIME_ZONE);
  const lastDay = addCalendarDays(today, HORIZON_DAYS - 1);
  const byDate = new Map(forecast.map((d) => [d.date, d]));
  const findings: WeatherFinding[] = [];

  for (const code of result.order) {
    const planned = result.activities.get(code)!;
    const row = schedule.byCode.get(code)!;
    if (planned.status === "complete" || !isWeatherSensitive(row.kind)) continue;

    // First planned working day inside the horizon with a weather risk.
    let hit: { date: string; risk: string; day: DailyForecast } | null = null;
    for (let index = planned.earlyStart; index < Math.max(planned.earlyFinish, planned.earlyStart + 1); index++) {
      const date = calendar.dateOf(index);
      if (date < today) continue;
      if (date > lastDay) break;
      const day = byDate.get(date);
      const risk = day ? weatherRisk(row.kind, day) : null;
      if (day && risk) {
        hit = { date, risk, day };
        break;
      }
    }
    if (!hit) continue;

    const key = `${projectId}:${code}:${hit.date}`;
    const [seen] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "weather.flagged"), eq(auditLog.subjectId, key)))
      .limit(1);
    if (seen) {
      findings.push({ activityCode: code, date: hit.date, risk: hit.risk, action: "skipped" });
      continue;
    }
    await audit(db, {
      companyId: project.companyId,
      projectId,
      actor: { type: "agent", id: WEATHER_AGENT },
      action: "weather.flagged",
      subject: { type: "weather_risk", id: key },
      reason: hit.risk,
    });

    const label = `${code} ${row.name}`;
    if (planned.status === "in_progress" || hit.date !== planned.startDate) {
      await notifyProject(deps, {
        companyId: project.companyId,
        projectId,
        title: `Weather warning for ${label}`,
        text: `Open-Meteo forecasts ${hit.risk} on ${longDate(hit.date)}, while ${label} is under way. Plan to protect the work or keep the crew on other tasks that day.`,
        requestedBy: WEATHER_AGENT,
      });
      findings.push({ activityCode: code, date: hit.date, risk: hit.risk, action: "warned" });
      continue;
    }

    // Hold the start until the first workday after the bad weather that is safe for this work.
    let notBefore = calendar.dateOf(calendar.indexOf(hit.date) + 1);
    for (let tries = 0; tries < 7; tries++) {
      const day = byDate.get(notBefore);
      if (!day || !weatherRisk(row.kind, day)) break;
      notBefore = calendar.dateOf(calendar.indexOf(notBefore) + 1);
    }

    const held = computeSchedule(
      schedule.activities.map((a) => (a.id === code ? { ...a, startNoEarlierThan: notBefore } : a)),
      calendar,
      { dataDate: project.dataDate },
    );
    const slip = held.projectFinish - result.projectFinish;
    const effect =
      slip > 0
        ? `This moves the forecast handover by ${plural(slip, "workday")}, to ${longDate(held.finishDate)}.`
        : `It has enough float, so the forecast handover stays ${longDate(result.finishDate)}.`;

    const pending = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.projectId, projectId), eq(approvals.status, "pending"), eq(approvals.kind, "schedule_change")));
    if (pending.some((a) => a.action.activityCode === code && a.action.notBefore === notBefore)) {
      findings.push({ activityCode: code, date: hit.date, risk: hit.risk, action: "skipped" });
      continue;
    }

    await deps.approvals.propose({
      companyId: project.companyId,
      projectId,
      kind: "schedule_change",
      title: `Hold ${label} until ${longDate(notBefore)}?`,
      summary: `Open-Meteo forecasts ${hit.risk} on ${longDate(hit.date)}, the day ${label} is planned to start. Starting on ${longDate(notBefore)} instead avoids it. ${effect}`,
      action: {
        type: SET_CONSTRAINT,
        projectId,
        activityCode: code,
        notBefore,
        reason: `${hit.risk} forecast on ${hit.date}`,
      },
      evidence: [{ label: `Open-Meteo forecast for ${hit.date}: ${hit.risk}` }],
      requestedBy: WEATHER_AGENT,
      expiresInHours: 24,
    });
    findings.push({ activityCode: code, date: hit.date, risk: hit.risk, action: "proposed_hold" });
  }
  return findings;
}

/** Queues today's weather check for every site once the morning check time has passed. */
export async function queueMorningWeatherChecks(deps: FeatureDeps): Promise<number> {
  const now = deps.now();
  if (localMinutes(now, deps.config.SITE_TIME_ZONE) < MORNING_CHECK_MINUTES) return 0;
  const today = localDate(now, deps.config.SITE_TIME_ZONE);
  const active = await deps.db.select().from(projects).where(eq(projects.active, true));
  let queued = 0;
  for (const project of active) {
    if (project.latitude === null || project.longitude === null) continue;
    const id = await enqueue(deps.db, WEATHER_CHECK_JOB, { projectId: project.id }, { idempotencyKey: `weather:${project.id}:${today}` });
    if (id !== null) queued++;
  }
  return queued;
}
