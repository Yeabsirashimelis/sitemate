import { describe, expect, it } from "vitest";
import { plannedValue, summarizeEarnedValue, type BudgetedActivity } from "../src/earned-value.js";

const activities: BudgetedActivity[] = [
  { id: "X", budget: 1000, baselineStart: 0, baselineFinish: 10, percentComplete: 50 },
  { id: "Y", budget: 500, baselineStart: 5, baselineFinish: 10, percentComplete: 0 },
];

describe("earned value", () => {
  it("spreads planned value evenly over the baseline", () => {
    expect(plannedValue(activities, 0)).toBe(0);
    expect(plannedValue(activities, 6)).toBe(700);
    expect(plannedValue(activities, 20)).toBe(1500);
  });

  it("summarizes schedule and cost performance", () => {
    const summary = summarizeEarnedValue(activities, 6, 600);
    expect(summary.earnedValue).toBe(500);
    expect(summary.scheduleVariance).toBe(-200);
    expect(summary.costVariance).toBe(-100);
    expect(summary.spi).toBeCloseTo(0.714, 3);
    expect(summary.cpi).toBeCloseTo(0.833, 3);
    expect(summary.estimateAtCompletion).toBeCloseTo(1800);
    expect(summary.varianceAtCompletion).toBeCloseTo(-300);
  });

  it("leaves ratios empty when there is nothing to compare", () => {
    const summary = summarizeEarnedValue(activities, 0, 0);
    expect(summary.spi).toBeNull();
    expect(summary.cpi).toBeNull();
    expect(summary.estimateAtCompletion).toBeNull();
  });

  it("rejects impossible progress", () => {
    expect(() => summarizeEarnedValue([{ ...activities[0]!, percentComplete: 120 }], 5, 100)).toThrow(/invalid progress/);
  });
});
