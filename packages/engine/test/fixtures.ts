import { WorkCalendar } from "../src/calendar.js";
import type { Activity } from "../src/schedule.js";

/** Every day is a working day, so workday indexes equal calendar days from the start. */
export const everyDay = new WorkCalendar("2026-01-05", { workingWeekdays: [0, 1, 2, 3, 4, 5, 6] });

/**
 * Textbook network, worked by hand:
 *
 *   A(3) -> B(4) -> D(5) -> F(2)
 *   A(3) -> C(2) -> E(3) -> F(2)
 *
 * Critical path A-B-D-F, 14 days. C and E each have 4 days of float.
 */
export const textbook: Activity[] = [
  { id: "A", name: "Excavation", duration: 3 },
  { id: "B", name: "Foundations", duration: 4, predecessors: [{ from: "A" }] },
  { id: "C", name: "Site drainage", duration: 2, predecessors: [{ from: "A" }] },
  { id: "D", name: "Ground floor columns", duration: 5, predecessors: [{ from: "B" }] },
  { id: "E", name: "Boundary wall", duration: 3, predecessors: [{ from: "C" }] },
  { id: "F", name: "Ground floor slab", duration: 2, predecessors: [{ from: "D" }, { from: "E" }] },
];
