/**
 * Splits contract and specification text into pieces for search.
 *
 * Documents are split at clause headings ("14.3 Delays caused by the
 * Employer", "Clause 14.3 ...", "SECTION 3 CONCRETE") rather than at a fixed
 * length, so each piece keeps its clause number and an answer can cite it.
 * Long clauses are cut at paragraph or sentence boundaries with a small
 * overlap.
 */

export interface Section {
  clause: string | null;
  heading: string | null;
  page: number | null;
  text: string;
}

export interface Chunk extends Section {
  ordinal: number;
}

const CLAUSE_HEADING = /^\s*(?:clause|article|section|sub-clause)?\s*(\d+(?:\.\d+){0,4})\.?\s+([A-Z][^\n]{2,120})$/i;
const CAPS_HEADING = /^\s*(?:SECTION|PART|CHAPTER)\s+([0-9A-Z]+)[\s:.-]+([A-Z][A-Z0-9 ,&/()-]{2,100})$/;

export function splitIntoSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { clause: null, heading: null, page: null, text: "" };
  let page: number | null = null;

  const flush = () => {
    if (current.text.trim()) sections.push({ ...current, text: current.text.trim() });
  };

  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const pageMark = /^\s*(?:---\s*)?page\s+(\d+)\s*(?:---)?\s*$/i.exec(rawLine);
    if (pageMark) {
      page = Number(pageMark[1]);
      if (!current.text.trim()) current.page = page;
      continue;
    }
    const heading = CLAUSE_HEADING.exec(rawLine) ?? CAPS_HEADING.exec(rawLine);
    // A heading line is short; a numbered sentence inside a paragraph is not.
    if (heading && rawLine.trim().length <= 130) {
      flush();
      current = { clause: heading[1]!, heading: heading[2]!.trim(), page, text: `${rawLine.trim()}\n` };
      continue;
    }
    current.text += `${rawLine}\n`;
  }
  flush();
  return sections;
}

/** Cuts long sections into pieces of about `size` characters, overlapping by `overlap`. */
export function chunkSections(sections: Section[], size = 1400, overlap = 150): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of sections) {
    const text = section.text.replace(/\n{3,}/g, "\n\n");
    if (text.length <= size) {
      chunks.push({ ...section, text, ordinal: chunks.length });
      continue;
    }
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + size, text.length);
      if (end < text.length) {
        const window = text.slice(start, end);
        const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "));
        if (breakAt > size * 0.5) end = start + breakAt + 1;
      }
      const piece = text.slice(start, end).trim();
      // Later pieces repeat the heading so they still make sense on their own.
      const prefix = start > 0 && section.clause ? `${section.clause} ${section.heading ?? ""} (continued)\n` : "";
      chunks.push({ ...section, text: prefix + piece, ordinal: chunks.length });
      if (end >= text.length) break;
      start = Math.max(end - overlap, start + 1);
    }
  }
  return chunks;
}

/** "clause 14.3", "cl. 14.3", "sub-clause 8.4.1" mentioned in a question. */
export function clausesMentioned(question: string): string[] {
  return [...question.matchAll(/(?:clause|cl\.|sub-clause|section|article)\s*(\d+(?:\.\d+)*)/gi)].map((m) => m[1]!);
}
