/**
 * Material forecasting.
 *
 * Usage is learned per unit of progress (bags of cement per square metre of
 * blockwork) rather than per day, because a site that does no blockwork on a
 * given day uses no cement for it. The rate is smoothed so one unusual day
 * does not swing the forecast.
 */

export interface UsageObservation {
  /** Quantity of material used that day, e.g. 42 bags. */
  quantityUsed: number;
  /** Progress made with it that day, e.g. 30 m2 of blockwork. */
  progress: number;
}

/**
 * Exponentially weighted average of usage per unit of progress, oldest
 * observation first. Days with no progress are skipped.
 */
export function estimateUsageRate(observations: readonly UsageObservation[], smoothing = 0.3): number | null {
  if (smoothing <= 0 || smoothing > 1) {
    throw new Error(`Smoothing must be in (0, 1], got ${smoothing}`);
  }
  let rate: number | null = null;
  for (const { quantityUsed, progress } of observations) {
    if (progress <= 0 || quantityUsed < 0) continue;
    const today = quantityUsed / progress;
    rate = rate === null ? today : smoothing * today + (1 - smoothing) * rate;
  }
  return rate;
}

export interface Delivery {
  /** Workdays from today, 0 = arrives today before work starts. */
  day: number;
  quantity: number;
}

export interface RunOutForecast {
  /** First workday (from today) on which the material runs short, or null if it lasts. */
  runOutDay: number | null;
  /** Stock left at the end of each planned day. */
  stockByDay: number[];
}

/**
 * Projects stock forward over the planned work, adding deliveries on the
 * day they arrive.
 */
export function forecastRunOut(input: {
  onHand: number;
  usagePerUnit: number;
  /** Planned progress for each coming workday, e.g. from the three week look ahead. */
  plannedProgress: readonly number[];
  deliveries?: readonly Delivery[];
}): RunOutForecast {
  let stock = input.onHand;
  let runOutDay: number | null = null;
  const stockByDay: number[] = [];

  input.plannedProgress.forEach((progress, day) => {
    for (const delivery of input.deliveries ?? []) {
      if (delivery.day === day) stock += delivery.quantity;
    }
    stock -= progress * input.usagePerUnit;
    if (stock < 0 && runOutDay === null) runOutDay = day;
    stockByDay.push(stock);
  });

  return { runOutDay, stockByDay };
}

/**
 * Stock level at which a new order has to go out: what the site will use
 * while the supplier delivers, plus a few days of margin.
 */
export function reorderPoint(input: { dailyUse: number; leadTimeDays: number; safetyDays: number }): number {
  return input.dailyUse * (input.leadTimeDays + input.safetyDays);
}

/**
 * The latest workday (from today) an order can be placed and still arrive
 * before the material runs out, or null if it is not needed in the horizon.
 * A negative value means the order is already late.
 */
export function latestOrderDay(forecast: RunOutForecast, leadTimeDays: number, safetyDays = 0): number | null {
  if (forecast.runOutDay === null) return null;
  return forecast.runOutDay - leadTimeDays - safetyDays;
}
