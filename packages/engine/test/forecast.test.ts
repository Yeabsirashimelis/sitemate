import { describe, expect, it } from "vitest";
import { estimateUsageRate, forecastRunOut, latestOrderDay, reorderPoint } from "../src/forecast.js";

describe("material forecasting", () => {
  it("learns usage per unit of progress and skips idle days", () => {
    const rate = estimateUsageRate(
      [
        { quantityUsed: 42, progress: 30 },
        { quantityUsed: 0, progress: 0 },
        { quantityUsed: 50, progress: 40 },
      ],
      0.5,
    );
    expect(rate).toBeCloseTo(1.325);
    expect(estimateUsageRate([])).toBeNull();
  });

  it("finds the day stock runs out, counting deliveries", () => {
    const forecast = forecastRunOut({
      onHand: 100,
      usagePerUnit: 1.4,
      plannedProgress: [30, 30, 30],
      deliveries: [{ day: 2, quantity: 20 }],
    });
    expect(forecast.stockByDay.map((s) => Math.round(s))).toEqual([58, 16, -6]);
    expect(forecast.runOutDay).toBe(2);
    expect(latestOrderDay(forecast, 3)).toBe(-1);
  });

  it("returns null when the stock lasts", () => {
    const forecast = forecastRunOut({ onHand: 500, usagePerUnit: 1, plannedProgress: [10, 10] });
    expect(forecast.runOutDay).toBeNull();
    expect(latestOrderDay(forecast, 5)).toBeNull();
  });

  it("sets the reorder point from lead time and margin", () => {
    expect(reorderPoint({ dailyUse: 40, leadTimeDays: 5, safetyDays: 2 })).toBe(280);
  });
});
