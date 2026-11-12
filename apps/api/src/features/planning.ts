/**
 * Weekly planning. Every Saturday the planning agent scores last week's plan
 * (percent plan complete: committed activities that actually finished),
 * commits the coming week's plan, and sends the project manager the look
 * ahead with everything that is blocked or at risk.
 */

import { addCalendarDays, computeSchedule } from "@sitemate/engine";
import { and, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { activities, projects, weeklyPlans } from "../db/schema.js";
import { plural } from "../domain/format.js";
import { localDate } from "../domain/time.js";
import { enqueue } from "../jobs/queue.js";
import { buildLookahead } from "../services/lookahead.js";
import { loadProjectSchedule } from "../services/schedule.js";
import { notifyProject } from "./notify.js";
import type { FeatureDeps } from "./types.js";

export const PLANNING_AGENT = "planning";
export const WEEKLY_PLAN_JOB = "planning.weekly";

/** Saturday, when site teams plan the coming week. */
const PLANNING_WEEKDAY = 6;

export function registerPlanningFeature(deps: FeatureDeps): void {
  deps.runner.register(WEEKLY_PLAN_JOB, {
    schema: z.object({ projectId: z.uuid(), weekStart: z.iso.date() }),
    handle: async ({ projectId, weekStart }) => {
      await runWeeklyPlanning(deps, projectId, weekStart);
    },
  });

  deps.scheduler.add("planning.weekly", async () => {
    const today = localDate(deps.now(), deps.config.SITE_TIME_ZONE);
    if (new Date(`${today}T00:00:00Z`).getUTCDay() !== PLANNING_WEEKDAY) return 0;
    const weekStart = addCalendarDays(today, 2); // the coming Monday
    const active = await deps.db.select({ id: projects.id }).from(projects).where(eq(projects.active, true));
    let queued = 0;
    for (const project of active) {
      const id = await enqueue(deps.db, WEEKLY_PLAN_JOB, { projectId: project.id, weekStart }, { idempotencyKey: `plan:${project.id}:${weekStart}` });
      if (id !== null) queued++;
    }
    return queued;
  });
}

/** Scores the last plan that has ended, commits the next one and reports. */
export async function runWeeklyPlanning(deps: FeatureDeps, projectId: string, weekStart: string) {
  const { db } = deps;
  const weekEnd = addCalendarDays(weekStart, 6);

  // Score every finished, unscored plan.
  const finishedCodes = new Set(
    (await db.select({ code: activities.code, actualFinish: activities.actualFinish }).from(activities).where(eq(activities.projectId, projectId)))
      .filter((a) => a.actualFinish !== null)
      .map((a) => a.code),
  );
  const toScore = await db
    .select()
    .from(weeklyPlans)
    .where(and(eq(weeklyPlans.projectId, projectId), lte(weeklyPlans.weekEnd, weekStart)));
  for (const plan of toScore.filter((p) => p.percentPlanComplete === null)) {
    const completed = plan.committed.filter((code) => finishedCodes.has(code));
    const ppc = plan.committed.length === 0 ? 100 : Math.round((completed.length / plan.committed.length) * 1000) / 10;
    await db.update(weeklyPlans).set({ completed, percentPlanComplete: ppc }).where(eq(weeklyPlans.id, plan.id));
  }

  // Commit next week: activities forecast to finish inside it.
  const schedule = await loadProjectSchedule(db, projectId);
  const result = computeSchedule(schedule.activities, schedule.calendar, { dataDate: schedule.project.dataDate });
  const committed = result.order.filter((code) => {
    const a = result.activities.get(code)!;
    return a.status !== "complete" && a.finishDate >= weekStart && a.finishDate <= weekEnd;
  });
  await db
    .insert(weeklyPlans)
    .values({ projectId, weekStart, weekEnd, committed })
    .onConflictDoUpdate({ target: [weeklyPlans.projectId, weeklyPlans.weekStart], set: { committed } });

  const lookahead = await buildLookahead(db, projectId);
  const blocked = lookahead.items.filter((i) => i.readiness === "blocked");
  const atRisk = lookahead.items.filter((i) => i.readiness === "at_risk");
  const [lastScored] = await db
    .select()
    .from(weeklyPlans)
    .where(and(eq(weeklyPlans.projectId, projectId), lte(weeklyPlans.weekEnd, weekStart)))
    .orderBy(desc(weeklyPlans.weekStart))
    .limit(1);

  const lines = [
    `Plan for the week starting ${weekStart}: ${plural(committed.length, "activity")} to finish${committed.length ? ` (${committed.join(", ")})` : ""}.`,
    lastScored?.percentPlanComplete !== null && lastScored?.percentPlanComplete !== undefined
      ? `Last week ${lastScored.percentPlanComplete}% of the plan was completed.`
      : "",
    blocked.length ? `\nBlocked:\n${blocked.map((i) => `- ${i.code} ${i.name}: ${i.constraints.filter((c) => c.severity === "blocking").map((c) => c.description).join("; ")}`).join("\n")}` : "",
    atRisk.length ? `\nAt risk:\n${atRisk.map((i) => `- ${i.code} ${i.name}: ${i.constraints.map((c) => c.description).join("; ")}`).join("\n")}` : "",
    !blocked.length && !atRisk.length ? "Everything in the next three weeks is ready." : "",
  ].filter(Boolean);

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  await notifyProject(deps, {
    companyId: project!.companyId,
    projectId,
    title: "Weekly look ahead",
    text: lines.join("\n"),
    requestedBy: PLANNING_AGENT,
  });
  return { committed, blocked: blocked.length, atRisk: atRisk.length };
}
