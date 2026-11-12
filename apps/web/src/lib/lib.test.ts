import { describe, expect, it } from "vitest";
import { describeAction, groupFeed, type FeedEntry } from "./activity";
import { birr, birrCompact, perfIndex, plural, slipText } from "./format";
import { materialState } from "./status";

describe("format", () => {
  it("writes money the way a quantity surveyor reads it", () => {
    expect(birr(1_250_000.4)).toBe("1,250,000 birr");
    expect(birr(null)).toBe("–");
    expect(birrCompact(1_250_000)).toBe("1.3M");
    expect(birrCompact(380_000)).toBe("380K");
    expect(birrCompact(4_500)).toBe("4,500");
  });

  it("always shows performance indexes with two decimals", () => {
    expect(perfIndex(1)).toBe("1.00");
    expect(perfIndex(0.9)).toBe("0.90");
    expect(perfIndex(undefined)).toBe("–");
  });

  it("describes slip in workdays", () => {
    expect(slipText(0)).toBe("On contract date");
    expect(slipText(1)).toBe("1 workday late");
    expect(slipText(-3)).toBe("3 workdays early");
    expect(plural(2, "activity", "activities")).toBe("2 activities");
  });
});

describe("activity feed", () => {
  const entry = (id: number, action: string, actorId = "site"): FeedEntry => ({
    id,
    actorType: "agent",
    actorId,
    action,
    reason: null,
    createdAt: "2026-11-12T08:00:00Z",
  });

  it("folds consecutive repeats by the same actor", () => {
    const groups = groupFeed([entry(5, "daily_log.applied"), entry(4, "daily_log.applied"), entry(3, "weather.flagged", "weather"), entry(2, "daily_log.applied")]);
    expect(groups.map((g) => [g.first.id, g.count])).toEqual([
      [5, 2],
      [3, 1],
      [2, 1],
    ]);
  });

  it("labels known actions and falls back to readable words", () => {
    expect(describeAction("action.procurement.place_order")).toBe("Placed a purchase order");
    expect(describeAction("action.something_new")).toBe("Something new");
  });
});

describe("material state", () => {
  it("does not call a material covered while its order is only raised", () => {
    expect(materialState({ status: "ok", orderBy: "2026-11-14", openOrderQuantity: 60 })).toMatchObject({ label: "Requested", needsAction: true });
  });

  it("shows the order date when stock runs out beyond the lead time", () => {
    expect(materialState({ status: "ok", orderBy: "2026-11-20", openOrderQuantity: 0 })).toMatchObject({ label: "Order by 20 Nov", needsAction: false });
  });

  it("passes the forecast status through otherwise", () => {
    expect(materialState({ status: "order_now", orderBy: "2026-11-12", openOrderQuantity: 0 })).toMatchObject({ label: "Order now", tone: "critical" });
    expect(materialState({ status: "ok", orderBy: null, openOrderQuantity: 0 })).toMatchObject({ label: "Covered", tone: "good" });
  });
});
