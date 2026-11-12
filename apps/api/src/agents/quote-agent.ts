/**
 * Reads a supplier's Telegram reply to a request for quotation. The model
 * only extracts what the supplier wrote; comparing and choosing is done in
 * code.
 */

import { z } from "zod";

export const QUOTE_AGENT = "procurement";

export const quoteSchema = z.object({
  isQuote: z.boolean().describe("True if the message gives a price for the requested material."),
  unitPrice: z.number().positive().nullable().describe("Price per unit exactly as written by the supplier."),
  currency: z.string().length(3).describe("ISO currency code. Birr is ETB. Use ETB if no currency is mentioned."),
  pricePer: z.string().nullable().describe("The unit the price is for, e.g. bag, ton, piece."),
  leadTimeDays: z.number().int().min(0).max(180).nullable().describe("Days until delivery, if stated."),
  reference: z.string().nullable().describe("A reference like PR-1A2B3C4D if the supplier quoted one."),
  note: z.string().nullable().describe("Conditions the supplier mentioned, e.g. transport not included, price valid 3 days."),
});

export type ParsedQuote = z.infer<typeof quoteSchema>;

export function quotePrompt(input: { supplier: string; open: Array<{ reference: string; material: string; quantity: number; unit: string }> }): string {
  return [
    "You read replies from building material suppliers in Ethiopia to a contractor's request for a price. Replies may be in English or Amharic and may use informal wording like '4200 birr per bag, 2 days'.",
    "Extract the quote exactly as written. Do not convert currencies or units and do not invent values.",
    `Supplier: ${input.supplier}`,
    "Open requests sent to this supplier:",
    ...input.open.map((o) => `- ${o.reference}: ${o.quantity} ${o.unit} of ${o.material}`),
    "",
    "Respond with JSON only.",
  ].join("\n");
}
