import { describe, expect, it } from "vitest";
import { checkExtraction, type Extraction, type SiteContext } from "../src/agents/site-agent.js";
import { inQuietHours, localDate, localMinutes, parseClock } from "../src/domain/time.js";
import { remainingFromProgress } from "../src/services/daily-logs.js";

const context: SiteContext = {
  projectName: "Bole G+4",
  logDate: "2026-01-08",
  supervisorName: "Abebe",
  language: "en",
  activities: [
    { code: "A20", name: "Foundations", zone: "Block A", unit: "m3", percentComplete: 40 },
    { code: "A30", name: "Site drainage", zone: "External", unit: "m", percentComplete: 0 },
  ],
  materials: [
    { name: "Cement", unit: "bag" },
    { name: "HCB blocks", unit: "pcs" },
  ],
  previous: null,
};

const base: Extraction = {
  summary: "Foundations continued.",
  weather: null,
  workers: [],
  progress: [],
  materialsReceived: [],
  materialsUsed: [],
  issues: [],
  photoChecks: [],
  missing: [],
  followUpQuestion: null,
  confidence: 0.9,
};

describe("checkExtraction", () => {
  it("drops unknown activities and never lets progress go backwards", () => {
    const checked = checkExtraction(
      {
        ...base,
        progress: [
          { activityCode: "a20", percentComplete: 30, quantityDone: 4, note: null },
          { activityCode: "A99", percentComplete: 50, quantityDone: null, note: null },
          { activityCode: "A30", percentComplete: 25.04, quantityDone: null, note: "trench dug" },
        ],
      },
      context,
    );
    expect(checked.progress).toEqual([
      { activityCode: "A20", percentComplete: 40, quantityDone: 4 },
      { activityCode: "A30", percentComplete: 25, note: "trench dug" },
    ]);
    expect(checked.corrections).toEqual([
      "A20: kept 40% instead of lower 30%",
      "Dropped progress for unknown activity A99",
    ]);
  });

  it("matches material names to tracked materials and merges repeats", () => {
    const checked = checkExtraction(
      {
        ...base,
        materialsUsed: [
          { material: "cement", quantity: 20, unit: "bag" },
          { material: "CEMENT ", quantity: 5, unit: "bag" },
          { material: "Sand", quantity: 2, unit: "m3" },
          { material: "Cement", quantity: 0, unit: "bag" },
        ],
      },
      context,
    );
    expect(checked.materialsUsed).toEqual([
      { material: "Cement", quantity: 25, unit: "bag" },
      { material: "Sand", quantity: 2, unit: "m3" },
    ]);
  });

  it("turns photo findings into issues", () => {
    const checked = checkExtraction(
      {
        ...base,
        photoChecks: [
          { description: "Formwork only, no concrete yet", matchesReport: false, concern: null },
          { description: "Scaffold on level 2", matchesReport: true, concern: "Open edge on level 2 without a guardrail" },
        ],
      },
      context,
    );
    expect(checked.issues).toEqual([
      { kind: "quality", description: "Photo does not match the report: Formwork only, no concrete yet", severity: "medium" },
      { kind: "safety", description: "Open edge on level 2 without a guardrail", severity: "medium" },
    ]);
  });

  it("merges workers by trade and ignores zero counts", () => {
    const checked = checkExtraction(
      {
        ...base,
        workers: [
          { trade: "Mason", count: 6 },
          { trade: "mason", count: 2 },
          { trade: "Carpenter", count: 0 },
        ],
      },
      context,
    );
    expect(checked.workers).toEqual([{ trade: "Mason", count: 8 }]);
  });
});

describe("time helpers", () => {
  // 14:30 UTC is 17:30 in Addis Ababa (UTC+3).
  const evening = new Date("2026-01-08T14:30:00Z");

  it("works in the site's time zone", () => {
    expect(localDate(evening, "Africa/Addis_Ababa")).toBe("2026-01-08");
    expect(localDate(new Date("2026-01-08T22:30:00Z"), "Africa/Addis_Ababa")).toBe("2026-01-09");
    expect(localMinutes(evening, "Africa/Addis_Ababa")).toBe(17 * 60 + 30);
    expect(parseClock("17:00")).toBe(1020);
  });

  it("handles quiet hours that cross midnight", () => {
    expect(inQuietHours(new Date("2026-01-08T19:00:00Z"), "Africa/Addis_Ababa", 20, 7)).toBe(true); // 22:00
    expect(inQuietHours(new Date("2026-01-08T09:00:00Z"), "Africa/Addis_Ababa", 20, 7)).toBe(false); // 12:00
    expect(inQuietHours(new Date("2026-01-08T09:00:00Z"), "Africa/Addis_Ababa", 9, 9)).toBe(false);
  });
});

describe("remainingFromProgress", () => {
  it("estimates remaining workdays from percent complete", () => {
    expect(remainingFromProgress(5, 0)).toBe(5);
    expect(remainingFromProgress(5, 50)).toBe(3);
    expect(remainingFromProgress(5, 99)).toBe(1);
    expect(remainingFromProgress(5, 100)).toBe(0);
  });
});
