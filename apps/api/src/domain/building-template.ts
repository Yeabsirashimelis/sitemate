/**
 * A first schedule for a building, from a few facts a contractor knows on
 * day one: floors, floor area, basement, roof type. Most small contractors
 * have no planning software, so this gives them a reasonable programme to
 * start from and adjust, built by code from the reinforced concrete frame
 * template, never invented by the model.
 */

import { z } from "zod";
import { frameBuilding, type DemoActivity } from "../seed/demo-project.js";

export const buildingParameters = z.object({
  /** Floors above the ground floor: a G+4 building has 4. */
  floors: z.number().int().min(0).max(20),
  /** Typical slab area of one floor, in square metres. */
  floorArea: z.number().min(40).max(5000),
  basement: z.boolean().default(false),
  roof: z.enum(["steel", "concrete"]).default("steel"),
  externalWorks: z.boolean().default(true),
  blockName: z.string().trim().min(1).max(40).default("Block A"),
});
export type BuildingParameters = z.infer<typeof buildingParameters>;

/** The frame template's durations are set for a floor of about this size. */
const REFERENCE_AREA = 420;

export type TemplateActivity = DemoActivity;

export function buildingSchedule(input: BuildingParameters): TemplateActivity[] {
  const p = buildingParameters.parse(input);
  const prefix = "B";
  const c = (n: number) => `${prefix}${n}`;
  const list = frameBuilding({ floors: p.floors, slabArea: p.floorArea, prefix, blockName: p.blockName });

  // Bigger floors take longer, but crews grow too, so time grows slower than area.
  const scale = Math.min(2.5, Math.max(0.6, (p.floorArea / REFERENCE_AREA) ** 0.6));
  for (const a of list) if (a.duration > 0) a.duration = Math.max(1, Math.round(a.duration * scale));

  const byCode = new Map(list.map((a) => [a.code, a]));
  const sub = `${p.blockName} substructure`;

  if (p.basement) {
    // Dig the whole basement first, then build its walls and slab before backfilling.
    const days = (d: number) => Math.max(1, Math.round(d * scale));
    const basement: TemplateActivity[] = [
      { code: c(1005), name: "Bulk excavation and shoring for the basement", duration: days(10), kind: "excavation", zone: sub, predecessors: [{ code: c(1000), type: "FS", lag: 0 }], progressUnit: "m3", plannedQuantity: Math.round(p.floorArea * 3.2), rate: 420 },
      { code: c(1055), name: "Basement retaining walls", duration: days(8), kind: "concrete_pour", zone: sub, predecessors: [{ code: c(1050), type: "FS", lag: 0 }], progressUnit: "m3", plannedQuantity: Math.round(p.floorArea * 0.12), rate: 10_800 },
      { code: c(1056), name: "Basement slab and waterproofing", duration: days(5), kind: "concrete_pour", zone: sub, predecessors: [{ code: c(1055), type: "FS", lag: 0 }], progressUnit: "m2", plannedQuantity: p.floorArea, rate: 2_100 },
    ];
    byCode.get(c(1010))!.predecessors = [{ code: c(1005), type: "FS", lag: 0 }];
    byCode.get(c(1060))!.predecessors = [{ code: c(1056), type: "FS", lag: 0 }];
    list.splice(1, 0, basement[0]!);
    list.splice(list.findIndex((a) => a.code === c(1060)), 0, basement[1]!, basement[2]!);
  }

  if (p.roof === "concrete") {
    // The top floor slab is the roof: no steel structure, just finishing it watertight.
    const structure = byCode.get(c(5000))!;
    structure.name = "Roof parapet and screed to falls";
    structure.kind = "concrete_pour";
    const cover = byCode.get(c(5010))!;
    cover.name = "Roof waterproofing membrane";
    cover.rate = 780;
  }

  if (!p.externalWorks) {
    const drop = c(5200);
    list.splice(list.findIndex((a) => a.code === drop), 1);
    const handover = byCode.get(c(5300))!;
    handover.predecessors = handover.predecessors.filter((link) => link.code !== drop);
  }

  return list;
}

/** Plain words for what was assumed, shown next to the draft so the manager can correct it. */
export function describeParameters(p: BuildingParameters): string {
  const storeys = p.floors === 0 ? "ground floor only" : `G+${p.floors}`;
  return [
    `${storeys}, about ${Math.round(p.floorArea)} m² per floor`,
    p.basement ? "with a basement" : "no basement",
    p.roof === "steel" ? "steel roof with sheeting" : "flat concrete roof",
    p.externalWorks ? "external works included" : "no external works",
  ].join(", ");
}
