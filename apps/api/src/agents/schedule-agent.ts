/**
 * Schedule agent prompt. The numbers (days of slip, days recovered, cost)
 * all come from the scheduling engine. The model's job is only to explain
 * them to a project manager in a few plain sentences.
 */

import { z } from "zod";

export const SCHEDULE_AGENT = "schedule";

export const explanationSchema = z.object({
  explanation: z
    .string()
    .describe("Three or four plain sentences for the project manager: what happened, why it moves the handover, and why this plan."),
  optionNotes: z
    .array(z.object({ measureId: z.string(), note: z.string().describe("One short sentence on the trade-off of this measure.") }))
    .describe("One note per measure in the plan."),
});

export type Explanation = z.infer<typeof explanationSchema>;

export const SYSTEM_PROMPT = [
  "You are the schedule agent of SiteMate, a project controls assistant for building contractors in Ethiopia.",
  "A delay was reported on site. The scheduling engine has already calculated its effect on the handover date and a recovery plan.",
  "Explain it to the project manager in plain, direct English, the way an experienced planner would on Telegram.",
  "",
  "Rules:",
  "- Use the numbers exactly as given. Do not calculate, round or invent any number, date or cost.",
  "- Mention the chain of activities that drives the delay when it helps.",
  "- Be honest about risk. If the plan does not recover all the days, say so.",
  "- No greetings, no headings, no bullet points in the explanation.",
  "",
  "Respond with JSON only.",
].join("\n");

export interface ExplanationInput {
  projectName: string;
  activity: { code: string; name: string };
  cause: string;
  delayDays: number;
  slipDays: number;
  finishBefore: string;
  finishAfter: string;
  contractFinish: string;
  criticalPath: string[];
  plan: Array<{ measureId: string; description: string; daysRecovered: number; cost: number; risk: string }>;
  planFinish: string;
  remainingSlip: number;
}

export function explanationPrompt(input: ExplanationInput): string {
  return JSON.stringify(input, null, 2);
}

/** Used when the model is unavailable, so the approval still goes out. */
export function fallbackExplanation(input: ExplanationInput): string {
  const recovered = input.slipDays - input.remainingSlip;
  return [
    `${input.activity.code} ${input.activity.name} is ${input.delayDays} workdays late (${input.cause}).`,
    `It is on the critical path, so the forecast handover moves from ${input.finishBefore} to ${input.finishAfter}.`,
    recovered > 0
      ? `The plan below recovers ${recovered} of the ${input.slipDays} days, giving a handover of ${input.planFinish}.`
      : "None of the recovery measures on file help with this delay.",
  ].join(" ");
}
