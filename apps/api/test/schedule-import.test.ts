import { describe, expect, it } from "vitest";
import { ImportError, parsePredecessors, parseScheduleCsv, validateImport } from "../src/domain/schedule-import.js";
import { defaultHolidays } from "../src/domain/holidays.js";

describe("parsePredecessors", () => {
  it("reads codes, link types and lags", () => {
    expect(parsePredecessors("A1010; A1020SS+2;A1030ff-1, A1040FS")).toEqual([
      { code: "A1010", type: "FS", lag: 0 },
      { code: "A1020", type: "SS", lag: 2 },
      { code: "A1030", type: "FF", lag: -1 },
      { code: "A1040", type: "FS", lag: 0 },
    ]);
    expect(parsePredecessors("")).toEqual([]);
  });

  it("rejects text it cannot read", () => {
    expect(() => parsePredecessors("A10 10??")).toThrow(/Cannot read predecessor/);
  });
});

describe("parseScheduleCsv", () => {
  it("reads a schedule exported from Excel, including quoted names and header aliases", () => {
    const csv = [
      "﻿Activity ID,Activity Name,Duration,Predecessors,Type,Location,Unit,Quantity",
      "A1010,Excavation,5,,excavation,Block A,m3,420",
      'A1020,"Footings, pad and strip",6,A1010,concrete_pour,Block A,m3,85',
      "A1030,Column starters,3,A1020SS+2,,Block A,,",
      "",
    ].join("\r\n");
    const activities = parseScheduleCsv(csv);
    expect(activities).toHaveLength(3);
    expect(activities[1]).toMatchObject({
      code: "A1020",
      name: "Footings, pad and strip",
      duration: 6,
      kind: "concrete_pour",
      zone: "Block A",
      progressUnit: "m3",
      plannedQuantity: 85,
      predecessors: [{ code: "A1010", type: "FS", lag: 0 }],
    });
    expect(activities[2]).toMatchObject({ kind: "general", predecessors: [{ code: "A1020", type: "SS", lag: 2 }] });
  });

  it("lists every bad row instead of stopping at the first", () => {
    const csv = ["code,name,duration", "A1,Good,3", "A2,,4", "A 3,Bad code,-1"].join("\n");
    try {
      parseScheduleCsv(csv);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      const problems = (error as ImportError).problems.join("\n");
      expect(problems).toMatch(/Row 3, name/);
      expect(problems).toMatch(/Row 4, code/);
      expect(problems).toMatch(/Row 4, duration/);
    }
  });

  it("requires the core columns", () => {
    expect(() => parseScheduleCsv("code,name\nA1,X")).toThrow(ImportError);
  });
});

describe("validateImport", () => {
  it("catches duplicate codes and missing predecessors", () => {
    expect(() =>
      validateImport([
        { code: "A", name: "A", duration: 1, kind: "general", predecessors: [] },
        { code: "A", name: "A again", duration: 1, kind: "general", predecessors: [{ code: "Z", type: "FS", lag: 0 }] },
      ]),
    ).toThrow(ImportError);
  });
});

describe("defaultHolidays", () => {
  it("returns the Ethiopian holidays inside the project dates", () => {
    expect(defaultHolidays("2026-09-01", "2027-01-31")).toEqual(["2026-09-11", "2026-09-27", "2027-01-07", "2027-01-19"]);
  });
});
