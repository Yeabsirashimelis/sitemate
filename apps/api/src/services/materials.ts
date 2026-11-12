/**
 * Material forecasting for a project.
 *
 * Usage per unit of progress is learned from the daily logs. Planned
 * progress comes from the schedule: each open activity that consumes the
 * material spreads its remaining quantity evenly over its remaining days.
 * Together they give a run-out date, compared with the supplier lead time to
 * decide when an order has to go out.
 */

import { computeSchedule, estimateUsageRate, forecastRunOut, latestOrderDay } from "@sitemate/engine";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Executor } from "../db/client.js";
import { materials, materialTransactions, purchaseRequests } from "../db/schema.js";
import { loadProjectSchedule } from "./schedule.js";

export type Material = typeof materials.$inferSelect;

/** Workdays ahead the forecast looks at: the three week look ahead. */
export const FORECAST_HORIZON = 18;

export type MaterialStatus = "ok" | "order_soon" | "order_now" | "no_usage_data";

export interface MaterialForecast {
  material: Material;
  usagePerUnit: number | null;
  /** Average use per workday over the horizon. */
  dailyUse: number;
  runOutDate: string | null;
  /** Latest date an order can go out and still arrive in time. */
  orderBy: string | null;
  status: MaterialStatus;
  /** Quantity used over the horizon. */
  plannedUse: number;
  openOrderQuantity: number;
}

const OPEN_PURCHASE: Array<(typeof purchaseRequests.$inferSelect)["status"]> = ["draft", "pending_approval", "approved", "ordered"];

export async function forecastMaterials(db: Executor, projectId: string): Promise<MaterialForecast[]> {
  const tracked = await db.select().from(materials).where(eq(materials.projectId, projectId)).orderBy(asc(materials.name));
  if (tracked.length === 0) return [];

  const schedule = await loadProjectSchedule(db, projectId);
  if (schedule.activities.length === 0) {
    return tracked.map((material) => emptyForecast(material, "no_usage_data"));
  }
  const { calendar, project } = schedule;
  const result = computeSchedule(schedule.activities, calendar, { dataDate: project.dataDate });
  const today = calendar.indexOf(project.dataDate);

  const usage = await db
    .select()
    .from(materialTransactions)
    .where(
      and(
        inArray(
          materialTransactions.materialId,
          tracked.map((m) => m.id),
        ),
        eq(materialTransactions.kind, "usage"),
        isNotNull(materialTransactions.progress),
      ),
    )
    .orderBy(asc(materialTransactions.date));

  const open = await db
    .select()
    .from(purchaseRequests)
    .where(and(eq(purchaseRequests.projectId, projectId), inArray(purchaseRequests.status, OPEN_PURCHASE)));

  const forecasts: MaterialForecast[] = [];
  for (const material of tracked) {
    const learned = estimateUsageRate(
      usage.filter((u) => u.materialId === material.id).map((u) => ({ quantityUsed: u.quantity, progress: u.progress ?? 0 })),
    );
    const rate = learned ?? material.usagePerUnit;
    if (learned !== null && learned !== material.usagePerUnit) {
      await db.update(materials).set({ usagePerUnit: Math.round(learned * 10_000) / 10_000 }).where(eq(materials.id, material.id));
    }

    const plannedProgress = new Array<number>(FORECAST_HORIZON).fill(0);
    for (const code of result.order) {
      const planned = result.activities.get(code)!;
      const row = schedule.byCode.get(code)!;
      if (planned.status === "complete" || !consumes(material, row)) continue;
      const remainingQuantity = (row.plannedQuantity ?? 0) * (1 - row.percentComplete / 100);
      const span = planned.earlyFinish - planned.earlyStart;
      if (remainingQuantity <= 0 || span <= 0) continue;
      for (let day = Math.max(planned.earlyStart, today); day < planned.earlyFinish; day++) {
        const offset = day - today;
        if (offset >= FORECAST_HORIZON) break;
        plannedProgress[offset]! += remainingQuantity / (planned.earlyFinish - Math.max(planned.earlyStart, today));
      }
    }

    const materialOrders = open.filter((p) => p.materialId === material.id);
    const deliveries = materialOrders
      .filter((p) => p.status === "ordered")
      .map((p) => ({ day: Math.max(0, calendar.indexOf(p.neededBy) - today), quantity: p.quantity }));
    const openOrderQuantity = materialOrders.reduce((sum, p) => sum + p.quantity, 0);

    if (rate === null) {
      forecasts.push({ ...emptyForecast(material, "no_usage_data"), openOrderQuantity });
      continue;
    }

    const runOut = forecastRunOut({ onHand: material.onHand, usagePerUnit: rate, plannedProgress, deliveries });
    const plannedUse = plannedProgress.reduce((sum, p) => sum + p * rate, 0);
    const latest = latestOrderDay(runOut, material.leadTimeDays, material.safetyDays);
    let status: MaterialStatus = "ok";
    // An order already on its way or waiting for approval covers the need.
    if (latest !== null && materialOrders.length === 0) status = latest <= 0 ? "order_now" : latest <= 3 ? "order_soon" : "ok";

    forecasts.push({
      material,
      usagePerUnit: rate,
      dailyUse: plannedUse / FORECAST_HORIZON,
      runOutDate: runOut.runOutDay === null ? null : calendar.dateOf(today + runOut.runOutDay),
      orderBy: latest === null ? null : calendar.dateOf(Math.max(today, today + latest)),
      status,
      plannedUse,
      openOrderQuantity,
    });
  }
  return forecasts;
}

/**
 * A material is used by an activity when the activity's kind is listed on the
 * material, or, if none are listed, when both are measured in the same unit.
 */
export function consumes(material: Pick<Material, "consumedBy" | "progressUnit">, activity: { kind: string; progressUnit: string | null }): boolean {
  if (material.consumedBy.length > 0) return material.consumedBy.includes(activity.kind);
  return !!material.progressUnit && material.progressUnit === activity.progressUnit;
}

function emptyForecast(material: Material, status: MaterialStatus): MaterialForecast {
  return {
    material,
    usagePerUnit: material.usagePerUnit,
    dailyUse: 0,
    runOutDate: null,
    orderBy: null,
    status,
    plannedUse: 0,
    openOrderQuantity: 0,
  };
}

/** Order enough for the lead time plus two working weeks of planned use, in whole units. */
export function orderQuantity(forecast: MaterialForecast): number {
  const days = forecast.material.leadTimeDays + forecast.material.safetyDays + 12;
  return Math.max(1, Math.ceil(forecast.dailyUse * days - Math.max(0, forecast.material.onHand)));
}
