import { describe, expect, it } from "vitest";
import { WorkCalendar } from "../src/calendar.js";
import { computeSchedule, ScheduleError, type Activity } from "../src/schedule.js";
import { everyDay, textbook } from "./fixtures.js";

describe("computeSchedule", () => {
  it("finds early and late dates, float and the critical path", () => {
    const result = computeSchedule(textbook, everyDay);
    const get = (id: string) => result.activities.get(id)!;

    expect(result.projectFinish).toBe(14);
    expect(result.finishDate).toBe("2026-01-18");
    expect(result.criticalPath).toEqual(["A", "B", "D", "F"]);

    expect(get("D")).toMatchObject({ earlyStart: 7, earlyFinish: 12, lateStart: 7, lateFinish: 12 });
    expect(get("C")).toMatchObject({ earlyStart: 3, earlyFinish: 5, lateStart: 7, lateFinish: 9 });

    const float = Object.fromEntries([...result.activities.values()].map((a) => [a.id, a.totalFloat]));
    expect(float).toEqual({ A: 0, B: 0, C: 4, D: 0, E: 4, F: 0 });

    expect(get("C").freeFloat).toBe(0);
    expect(get("E").freeFloat).toBe(4);
  });

  it("turns indexes into dates", () => {
    const d = computeSchedule(textbook, everyDay).activities.get("D")!;
    expect(d.startDate).toBe("2026-01-12");
    expect(d.finishDate).toBe("2026-01-16");
  });

  it("handles start-to-start and finish-to-finish links with lags", () => {
    const result = computeSchedule(
      [
        { id: "A", name: "Blockwork", duration: 5 },
        { id: "B", name: "Electrical conduits", duration: 4, predecessors: [{ from: "A", type: "SS", lag: 2 }] },
        { id: "C", name: "Plastering", duration: 3, predecessors: [{ from: "A", type: "FF", lag: 1 }] },
      ],
      everyDay,
    );
    expect(result.activities.get("B")).toMatchObject({ earlyStart: 2, earlyFinish: 6 });
    expect(result.activities.get("C")).toMatchObject({ earlyStart: 3, earlyFinish: 6 });
    expect(result.projectFinish).toBe(6);
    for (const activity of result.activities.values()) expect(activity.totalFloat).toBe(0);
  });

  it("holds an activity until its start-no-earlier-than date", () => {
    const moved = textbook.map((a): Activity => (a.id === "F" ? { ...a, startNoEarlierThan: "2026-01-20" } : a));
    const result = computeSchedule(moved, everyDay);
    const get = (id: string) => result.activities.get(id)!;

    expect(get("F")).toMatchObject({ earlyStart: 15, earlyFinish: 17, startDate: "2026-01-20" });
    expect(result.projectFinish).toBe(17);
    // The constraint now drives the finish, so the columns gain three days of float.
    expect(get("D").totalFloat).toBe(3);
    expect(result.criticalPath).toEqual(["F"]);

    // A date that is already past has no effect.
    const past = textbook.map((a): Activity => (a.id === "F" ? { ...a, startNoEarlierThan: "2026-01-06" } : a));
    expect(computeSchedule(past, everyDay).projectFinish).toBe(14);
  });

  it("schedules remaining work from the data date", () => {
    const progressed = textbook.map((a): Activity => {
      if (a.id === "A") return { ...a, actualStart: "2026-01-05", actualFinish: "2026-01-07" };
      if (a.id === "B") return { ...a, actualStart: "2026-01-08", remainingDuration: 4 };
      return a;
    });
    const result = computeSchedule(progressed, everyDay, { dataDate: "2026-01-10" });
    const get = (id: string) => result.activities.get(id)!;

    expect(get("A").status).toBe("complete");
    expect(get("A").critical).toBe(false);
    expect(get("B")).toMatchObject({ status: "in_progress", earlyStart: 3, earlyFinish: 9 });
    // C could have started on day 3, but nothing unfinished starts before the data date.
    expect(get("C")).toMatchObject({ earlyStart: 5, earlyFinish: 7 });
    expect(get("D")).toMatchObject({ earlyStart: 9, earlyFinish: 14 });
    expect(result.projectFinish).toBe(16);
    expect(result.criticalPath).toEqual(["B", "D", "F"]);
  });

  it("reports a loop in the logic with the activities involved", () => {
    const looped: Activity[] = [
      { id: "A", name: "A", duration: 1, predecessors: [{ from: "C" }] },
      { id: "B", name: "B", duration: 1, predecessors: [{ from: "A" }] },
      { id: "C", name: "C", duration: 1, predecessors: [{ from: "B" }] },
      { id: "D", name: "D", duration: 1, predecessors: [{ from: "C" }] },
    ];
    try {
      computeSchedule(looped, everyDay);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduleError);
      expect((error as Error).message).toMatch(/loop/);
      expect((error as ScheduleError).details.activityIds?.sort()).toEqual(["A", "B", "C", "D"]);
    }
  });

  it("rejects unknown predecessors, duplicates and bad durations", () => {
    expect(() => computeSchedule([{ id: "A", name: "A", duration: 1, predecessors: [{ from: "X" }] }], everyDay)).toThrow(
      /unknown activity "X"/,
    );
    expect(() =>
      computeSchedule(
        [
          { id: "A", name: "A", duration: 1 },
          { id: "A", name: "A again", duration: 2 },
        ],
        everyDay,
      ),
    ).toThrow(/Duplicate/);
    expect(() => computeSchedule([{ id: "A", name: "A", duration: -1 }], everyDay)).toThrow(/invalid duration/);
  });

  it("schedules a 500 activity chain quickly", () => {
    const chain: Activity[] = Array.from({ length: 500 }, (_, i) => ({
      id: `a${i}`,
      name: `Activity ${i}`,
      duration: 1 + (i % 4),
      ...(i > 0 ? { predecessors: [{ from: `a${i - 1}` }] } : {}),
    }));
    const started = performance.now();
    const result = computeSchedule(chain, new WorkCalendar("2026-01-03"));
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.criticalPath).toHaveLength(500);
  });
});
