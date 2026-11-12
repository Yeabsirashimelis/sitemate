/**
 * Generators for realistic demo schedules: a reinforced concrete frame
 * building, floor by floor, with the quantities, BOQ rates and logic a small
 * Ethiopian contractor would use. Rates are typical Addis Ababa figures in
 * birr for 2026 and are for demonstration only.
 */

import type { ImportedActivity } from "../domain/schedule-import.js";

export interface DemoActivity extends ImportedActivity {
  rate?: number;
  boqUnit?: string;
}

type Kind = ImportedActivity["kind"];

function activity(
  code: string,
  name: string,
  duration: number,
  kind: Kind,
  zone: string,
  predecessors: Array<string | { code: string; type: "FS" | "SS" | "FF" | "SF"; lag: number }>,
  quantity?: { unit: string; amount: number; rate: number },
): DemoActivity {
  return {
    code,
    name,
    duration,
    kind,
    zone,
    predecessors: predecessors.map((p) => (typeof p === "string" ? { code: p, type: "FS" as const, lag: 0 } : p)),
    ...(quantity ? { progressUnit: quantity.unit, plannedQuantity: quantity.amount, rate: quantity.rate } : {}),
  };
}

/**
 * Ground plus `floors` frame building. Codes follow the usual pattern:
 * 1xxx substructure, 2xxx frame per floor, 3xxx walls and services,
 * 4xxx finishes, 5xxx roof and external works.
 */
export function frameBuilding(options: { floors: number; slabArea: number; prefix: string; blockName: string }): DemoActivity[] {
  const { floors, slabArea, prefix, blockName } = options;
  const c = (n: number) => `${prefix}${n}`;
  const list: DemoActivity[] = [];
  const sub = `${blockName} substructure`;

  list.push(activity(c(1000), "Site clearing and setting out", 3, "general", sub, []));
  list.push(activity(c(1010), "Excavation for footings", 6, "excavation", sub, [c(1000)], { unit: "m3", amount: slabArea * 1.1, rate: 380 }));
  list.push(activity(c(1020), "Blinding concrete", 2, "concrete_pour", sub, [c(1010)], { unit: "m3", amount: slabArea * 0.05, rate: 7_200 }));
  list.push(activity(c(1030), "Footing reinforcement and formwork", 5, "general", sub, [c(1020)]));
  list.push(activity(c(1040), "Pour footings", 3, "concrete_pour", sub, [c(1030)], { unit: "m3", amount: slabArea * 0.22, rate: 9_800 }));
  list.push(activity(c(1050), "Column starters and grade beam", 6, "concrete_pour", sub, [c(1040)], { unit: "m3", amount: slabArea * 0.08, rate: 10_400 }));
  list.push(activity(c(1060), "Backfill and compaction", 4, "excavation", sub, [c(1050)], { unit: "m3", amount: slabArea * 0.6, rate: 260 }));
  list.push(activity(c(1070), "Hardcore and ground floor slab", 5, "concrete_pour", sub, [c(1060)], { unit: "m2", amount: slabArea, rate: 1_650 }));

  let previousSlab = c(1070);
  for (let floor = 1; floor <= floors; floor++) {
    const z = `${blockName} floor ${floor}`;
    const base = 2000 + floor * 100;
    list.push(activity(c(base), `Floor ${floor} columns`, 5, "concrete_pour", z, [previousSlab], { unit: "m3", amount: slabArea * 0.035, rate: 11_000 }));
    list.push(activity(c(base + 10), `Floor ${floor} beam and slab formwork`, 6, "general", z, [{ code: c(base), type: "SS", lag: 3 }]));
    list.push(activity(c(base + 20), `Floor ${floor} slab reinforcement`, 5, "general", z, [{ code: c(base + 10), type: "SS", lag: 3 }, c(base)]));
    list.push(activity(c(base + 30), `Pour floor ${floor} slab`, 2, "concrete_pour", z, [c(base + 10), c(base + 20)], { unit: "m3", amount: slabArea * 0.18, rate: 9_800 }));
    list.push(activity(c(base + 40), `Floor ${floor} slab curing and striking`, 7, "general", z, [c(base + 30)]));
    previousSlab = c(base + 40);
  }

  // Walls and services follow the frame, one floor behind.
  for (let floor = 0; floor <= floors; floor++) {
    const z = `${blockName} ${floor === 0 ? "ground floor" : `floor ${floor}`}`;
    const base = 3000 + floor * 100;
    const ready = floor === 0 ? c(1070) : c(2000 + floor * 100 + 40);
    list.push(activity(c(base), `${floor === 0 ? "Ground floor" : `Floor ${floor}`} HCB blockwork`, 6, "masonry", z, [ready], { unit: "m2", amount: slabArea * 0.9, rate: 680 }));
    list.push(activity(c(base + 10), `${floor === 0 ? "Ground floor" : `Floor ${floor}`} electrical and plumbing rough-in`, 5, "mep", z, [{ code: c(base), type: "SS", lag: 3 }]));
    list.push(activity(c(base + 20), `${floor === 0 ? "Ground floor" : `Floor ${floor}`} internal plastering`, 7, "finishing", z, [c(base), c(base + 10)], { unit: "m2", amount: slabArea * 1.8, rate: 320 }));
  }

  const roofReady = c(2000 + floors * 100 + 40);
  list.push(activity(c(5000), "Roof steel structure", 6, "roofing", `${blockName} roof`, [roofReady]));
  list.push(activity(c(5010), "Roof sheeting and gutters", 5, "roofing", `${blockName} roof`, [c(5000)], { unit: "m2", amount: slabArea, rate: 950 }));

  for (let floor = 0; floor <= floors; floor++) {
    const z = `${blockName} ${floor === 0 ? "ground floor" : `floor ${floor}`}`;
    const base = 4000 + floor * 100;
    const label = floor === 0 ? "Ground floor" : `Floor ${floor}`;
    list.push(activity(c(base), `${label} screed and tiling`, 6, "finishing", z, [c(3000 + floor * 100 + 20)], { unit: "m2", amount: slabArea * 0.85, rate: 1_450 }));
    list.push(activity(c(base + 10), `${label} doors, windows and painting`, 6, "finishing", z, [c(base)]));
  }

  const lastFinish = c(4000 + floors * 100 + 10);
  list.push(activity(c(5100), "External plaster and painting", 10, "finishing", `${blockName} facade`, [c(5010), c(3000 + floors * 100 + 20)], { unit: "m2", amount: slabArea * 2.2, rate: 420 }));
  list.push(activity(c(5200), "Septic tank, drainage and paving", 8, "excavation", "External works", [{ code: c(1070), type: "FS", lag: 10 }], { unit: "m2", amount: slabArea * 0.5, rate: 900 }));
  list.push(activity(c(5300), "Testing, snagging and handover", 4, "general", blockName, [lastFinish, c(5100), c(5200)]));
  list.push(activity(c(5310), "Practical completion", 0, "milestone", blockName, [c(5300)]));
  return list;
}

export const CONTRACT_TEXT = `CONDITIONS OF CONTRACT
Page 1
1 Definitions
The Employer is the client named in the Contract Agreement. The Engineer is the consultant appointed by the Employer to administer the Contract.
8.2 Time for Completion
The Contractor shall complete the whole of the Works within the Time for Completion stated in the Contract Agreement.
8.4 Programme
The Contractor shall submit a detailed programme within 14 days of the Commencement Date and a revised programme whenever the previous one is inconsistent with actual progress.
Page 2
14.3 Extension of Time for Completion
The Contractor shall be entitled to an extension of the Time for Completion if completion is or will be delayed by exceptionally adverse climatic conditions, by any delay, impediment or prevention caused by the Employer, including late payment, or by late drawings or instructions from the Engineer.
14.4 Notice of Claims
If the Contractor considers himself entitled to an extension of time, he shall give notice to the Engineer describing the event not later than 28 days after he became aware, or should have become aware, of the event. If he fails to do so the Time for Completion shall not be extended.
14.5 Contemporary Records
The Contractor shall keep contemporary records, including daily site records and photographs, as may be necessary to substantiate any claim.
Page 3
16.1 Interim Payment Certificates
The Contractor shall submit a statement at the end of each month showing the value of the Works executed, supported by measurements.
16.2 Payment
The Employer shall pay the amount certified in each Interim Payment Certificate within 30 days after the Engineer receives the statement. Retention of five percent shall be deducted from each payment.
17.1 Delay Damages
If the Contractor fails to complete the Works within the Time for Completion, he shall pay delay damages of 0.1 percent of the Contract Price for every day of delay, up to a maximum of 10 percent.
`;

export const SPECIFICATION_TEXT = `SECTION 3: CONCRETE WORKS
3.1 Cement
Cement shall be Ordinary Portland Cement or Portland Pozzolana Cement complying with Ethiopian Standard ES 1177.
3.2 Concrete Grades
Concrete for footings, columns, beams and slabs shall be grade C25 with a minimum cement content of 350 kg per cubic metre. Blinding shall be grade C15.
3.3 Curing
All structural concrete shall be kept continuously wet for at least 7 days after placing. Formwork to slab soffits shall not be struck earlier than 14 days after placing.
3.4 Reinforcement
Reinforcement shall be deformed high yield steel bars grade 60. Minimum cover shall be 25 mm for slabs and 40 mm for columns and footings.
SECTION 4: MASONRY
4.1 Hollow Concrete Blocks
Hollow concrete blocks shall be 200 mm thick for external walls and 150 mm for internal walls, class C, with a minimum crushing strength of 3.5 MPa.
4.2 Mortar
Mortar for blockwork shall be cement and sand 1:4 by volume.
`;
