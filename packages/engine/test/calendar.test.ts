import { describe, expect, it } from "vitest";
import { WorkCalendar } from "../src/calendar.js";

describe("WorkCalendar", () => {
  // 2026-01-03 is a Saturday, 2026-01-07 is Genna (Ethiopian Christmas).
  const calendar = new WorkCalendar("2026-01-03", { holidays: ["2026-01-07"] });

  it("skips Sundays and holidays on a six day week", () => {
    expect(calendar.dateOf(0)).toBe("2026-01-03");
    expect(calendar.dateOf(1)).toBe("2026-01-05");
    expect(calendar.dateOf(2)).toBe("2026-01-06");
    expect(calendar.dateOf(3)).toBe("2026-01-08");
  });

  it("maps a non-working date to the next working day", () => {
    expect(calendar.indexOf("2026-01-04")).toBe(1);
    expect(calendar.indexOf("2026-01-07")).toBe(3);
  });

  it("round trips dates and indexes", () => {
    for (let i = 0; i < 400; i++) {
      expect(calendar.indexOf(calendar.dateOf(i))).toBe(i);
    }
  });

  it("counts workdays between two dates", () => {
    expect(calendar.workdaysBetween("2026-01-03", "2026-01-10")).toBe(5);
  });

  it("rejects bad input", () => {
    expect(() => calendar.indexOf("2026-01-01")).toThrow(/before the project start/);
    expect(() => calendar.dateOf(-1)).toThrow();
    expect(() => new WorkCalendar("2026-1-3")).toThrow(/Invalid date/);
    expect(() => new WorkCalendar("2026-01-03", { workingWeekdays: [] })).toThrow();
  });
});
