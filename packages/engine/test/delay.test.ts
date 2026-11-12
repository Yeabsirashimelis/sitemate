import { describe, expect, it } from "vitest";
import { analyzeDelay, applyDelay, planRecovery, type RecoveryMeasure } from "../src/delay.js";
import { computeSchedule } from "../src/schedule.js";
import { everyDay, textbook } from "./fixtures.js";

const dataDate = "2026-01-05";

describe("analyzeDelay", () => {
  it("absorbs a delay that fits inside the float", () => {
    const impact = analyzeDelay(textbook, everyDay, { activityId: "C", days: 3, dataDate });
    expect(impact.floatBefore).toBe(4);
    expect(impact.slipDays).toBe(0);
  });

  it("moves the finish by the part of the delay that exceeds the float", () => {
    const impact = analyzeDelay(textbook, everyDay, { activityId: "C", days: 6, dataDate });
    expect(impact.slipDays).toBe(2);
    expect(impact.after.criticalPath).toEqual(["A", "C", "E", "F"]);
    expect(impact.newlyCritical.sort()).toEqual(["C", "E"]);
  });

  it("moves the finish day for day on the critical path", () => {
    const impact = analyzeDelay(textbook, everyDay, { activityId: "D", days: 3, dataDate });
    expect(impact.slipDays).toBe(3);
    expect(impact.after.finishDate).toBe("2026-01-21");
  });

  it("adds the delay to the remaining work of an activity in progress", () => {
    const progressed = textbook.map((a) => (a.id === "B" ? { ...a, actualStart: "2026-01-08", remainingDuration: 2 } : a));
    const delayed = applyDelay(progressed, { activityId: "B", days: 3 });
    expect(delayed.find((a) => a.id === "B")).toMatchObject({ duration: 4, remainingDuration: 5 });
  });
});

describe("planRecovery", () => {
  const delayed = applyDelay(textbook, { activityId: "D", days: 3 });
  const target = computeSchedule(textbook, everyDay).projectFinish;

  const candidates: RecoveryMeasure[] = [
    {
      id: "second-column-crew",
      description: "Second steel fixing crew on the ground floor columns",
      change: { kind: "shorten", activityId: "D", days: 2 },
      cost: 20_000,
      risk: "low",
    },
    {
      id: "slab-saturday",
      description: "Saturday and Sunday shift on the slab",
      change: { kind: "shorten", activityId: "F", days: 1 },
      cost: 5_000,
      risk: "low",
    },
    {
      id: "drainage-overtime",
      description: "Overtime on site drainage",
      change: { kind: "shorten", activityId: "C", days: 1 },
      cost: 1_000,
      risk: "low",
    },
    {
      id: "overlap-columns",
      description: "Start columns two days into the foundations, section by section",
      change: { kind: "relink", activityId: "D", from: "B", type: "SS", lag: 2 },
      cost: 3_000,
      risk: "medium",
    },
  ];

  it("ranks the measures that help by cost per day recovered", () => {
    const { options } = planRecovery(delayed, everyDay, dataDate, target, candidates);
    expect(options.map((o) => [o.measure.id, o.daysRecovered])).toEqual([
      ["overlap-columns", 2],
      ["slab-saturday", 1],
      ["second-column-crew", 2],
    ]);
  });

  it("builds the cheapest plan that holds the original date", () => {
    const { plan } = planRecovery(delayed, everyDay, dataDate, target, candidates);
    expect(plan.measures.map((m) => m.measure.id)).toEqual(["overlap-columns", "slab-saturday"]);
    expect(plan.totalCost).toBe(8_000);
    expect(plan.daysRecovered).toBe(3);
    expect(plan.remainingSlip).toBe(0);
    expect(plan.finishDate).toBe("2026-01-18");
  });

  it("reports the slip it cannot recover", () => {
    const { plan } = planRecovery(delayed, everyDay, dataDate, target, candidates.slice(0, 1));
    expect(plan.daysRecovered).toBe(2);
    expect(plan.remainingSlip).toBe(1);
  });
});
