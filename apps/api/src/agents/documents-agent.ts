/**
 * Prompts for reading documents and answering questions about a project.
 * Answers must come from the records and clauses given and cite them; when
 * the answer is not there, the model has to say so.
 */

import { z } from "zod";

export const DOCUMENTS_AGENT = "documents";

export const pdfSectionsSchema = z.object({
  sections: z.array(
    z.object({
      clause: z.string().nullable().describe("Clause or section number exactly as printed, e.g. 14.3. Null if none."),
      heading: z.string().nullable(),
      page: z.number().int().min(1).nullable(),
      text: z.string().describe("The full text of the clause, word for word."),
    }),
  ),
});

export const PDF_SYSTEM = [
  "You convert a construction contract, specification or letter into clauses.",
  "Copy the text word for word. Do not summarise, shorten or correct anything.",
  "Start a new section at each numbered clause or section heading and keep its number and heading.",
  "Give the page number each section starts on.",
  "Respond with JSON only.",
].join("\n");

export const answerSchema = z.object({
  found: z.boolean().describe("False if the sources do not contain the answer."),
  answer: z.string().describe("A direct answer in two to five plain sentences, with numbers and dates from the sources."),
  citations: z.array(z.string()).describe("Ids of the sources used, e.g. S2 or R1. Only ids that appear in the sources."),
});

export type Answer = z.infer<typeof answerSchema>;

export const ANSWER_SYSTEM = [
  "You are SiteMate, the project controls assistant of a building contractor in Ethiopia.",
  "Answer the project manager's question using only the sources given: project records (R) and document clauses (S).",
  "Rules:",
  "- If the sources do not answer the question, set found to false and say what is missing. Never use general knowledge to fill a gap about this project or its contract.",
  "- Quote numbers, dates and clause numbers exactly.",
  "- Cite every source you rely on by its id.",
  "- Plain sentences, no headings or bullet points.",
  "Respond with JSON only.",
].join("\n");

export const specCheckSchema = z.object({
  conflicts: z.array(
    z.object({
      activityCode: z.string(),
      reported: z.string().describe("What the supervisor reported."),
      requirement: z.string().describe("What the specification requires, quoted."),
      sourceId: z.string().describe("Id of the specification clause, e.g. S1."),
    }),
  ),
});

export const SPEC_CHECK_SYSTEM = [
  "You compare what a site supervisor reported today with the project specification clauses given.",
  "List only clear conflicts, for example a lower concrete grade, a wrong bar size, missing curing, or a wrong mix.",
  "If the report does not mention the detail a clause covers, that is not a conflict. When in doubt, leave it out.",
  "Respond with JSON only.",
].join("\n");
