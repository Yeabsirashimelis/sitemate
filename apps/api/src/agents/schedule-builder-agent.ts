import { z } from "zod";
import type { BuildingParameters } from "../domain/building-template.js";

export const SCHEDULE_BUILDER_AGENT = "schedule";

/** What the model may say about a building. Anything it cannot tell from the text stays null. */
export const buildingDescriptionSchema = z.object({
  floors: z.number().int().min(0).max(20).nullable().describe("Floors above ground. G+4 means 4. Ground floor only means 0."),
  floorArea: z.number().min(40).max(5000).nullable().describe("Typical area of one floor in square metres, if stated or clearly implied."),
  basement: z.boolean().nullable().describe("True if a basement or underground parking is mentioned."),
  roof: z.enum(["steel", "concrete"]).nullable().describe("steel for a pitched or sheeted roof, concrete for a flat slab roof or roof terrace."),
  externalWorks: z.boolean().nullable().describe("False only if the text says external works, drainage or paving are not in this contract."),
  blockName: z.string().nullable().describe("The building's name or block label if given, e.g. 'Block B'. Otherwise null."),
});

export function scheduleBuilderPrompt(): string {
  return [
    "You read a short description of a building project from an Ethiopian contractor, in English or Amharic, and pick out a few facts about the building.",
    "Only report what the text says or clearly implies. If something is not there, use null; never guess numbers.",
    "Floors are counted above the ground floor: G+4 is 4, 'five storeys' is 4, 'ground floor only' is 0.",
    "If only the total built area is given, divide it by the number of storeys including the ground floor to get the floor area.",
    "",
    "Respond with JSON only.",
  ].join("\n");
}

const DEFAULTS = { floors: 2, floorArea: 300 } as const;

/** Fills what the description left out and says so, so the manager can correct it before using the schedule. */
export function toParameters(found: z.infer<typeof buildingDescriptionSchema>): { parameters: BuildingParameters; assumptions: string[] } {
  const assumptions: string[] = [];
  if (found.floors === null) assumptions.push(`The number of floors was not given, so G+${DEFAULTS.floors} is assumed.`);
  if (found.floorArea === null) assumptions.push(`The floor area was not given, so ${DEFAULTS.floorArea} m² per floor is assumed.`);
  if (found.roof === null) assumptions.push("The roof type was not given, so a steel roof with sheeting is assumed.");
  return {
    parameters: {
      floors: found.floors ?? DEFAULTS.floors,
      floorArea: found.floorArea ?? DEFAULTS.floorArea,
      basement: found.basement ?? false,
      roof: found.roof ?? "steel",
      externalWorks: found.externalWorks ?? true,
      blockName: found.blockName?.trim() || "Block A",
    },
    assumptions,
  };
}
