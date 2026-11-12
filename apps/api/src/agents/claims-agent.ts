/**
 * Claims agent prompts. Classifying the cause of a delay needs judgement,
 * so the model does that, but which causes are claimable is decided in code
 * from the contract's usual allocation of risk.
 */

import { z } from "zod";

export const CLAIMS_AGENT = "claims";

export const classificationSchema = z.object({
  cause: z.enum(["weather", "late_information", "late_payment", "client_change", "access", "supplier", "other"]),
  responsible: z.enum(["client", "consultant", "contractor", "neutral"]),
  title: z.string().describe("Short title, e.g. 'Late rebar drawings for ground floor columns'."),
  reasoning: z.string().describe("One sentence on why this cause and party."),
});

export type Classification = z.infer<typeof classificationSchema>;

export const CLASSIFY_SYSTEM = [
  "You classify the cause of a delay on a building project in Ethiopia for a contractor's claims file.",
  "Causes: weather (rain, flooding), late_information (late drawings, answers or instructions from the consultant), late_payment (client paid late),",
  "client_change (client changed the design or scope), access (site not available, permits held by the client), supplier (late or wrong delivery from the contractor's own supplier), other.",
  "Responsible: client, consultant, contractor, or neutral (nobody's fault, such as exceptional weather).",
  "A supplier delay is the contractor's own risk unless the client nominated or paid for that supplier.",
  "Use only the facts given. Respond with JSON only.",
].join("\n");

export const noticeSchema = z.object({
  subject: z.string(),
  body: z.string().describe("The letter body in plain, formal English, five to eight short paragraphs. No placeholders except for the signature block."),
});

export const NOTICE_SYSTEM = [
  "You draft a notice of delay and intention to claim an extension of time, from a building contractor to the Engineer (the consultant) on an Ethiopian project.",
  "Use only the facts, dates, numbers and clause references given. Do not invent clause numbers, dates or amounts.",
  "State the event, when it started, the activities affected, the effect on the Time for Completion from the contractor's schedule analysis, the contract clauses relied on, and that records are being kept and further particulars will follow.",
  "Formal and direct. Respond with JSON only.",
].join("\n");

/** Which causes the contractor can claim time for under typical Ethiopian and FIDIC-based building contracts. */
export function isClaimable(classification: Pick<Classification, "cause" | "responsible">): boolean {
  if (classification.responsible === "client" || classification.responsible === "consultant") return true;
  return classification.cause === "weather" && classification.responsible === "neutral";
}
