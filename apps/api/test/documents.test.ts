import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { documents } from "../src/db/schema.js";
import { chunkSections, clausesMentioned, splitIntoSections } from "../src/domain/chunking.js";
import { textQuery } from "../src/services/documents.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { addLinkedUser, deliver, setupSiteProject } from "./helpers/fixtures.js";
import { textUpdate } from "./helpers/telegram.js";

const CONTRACT = `CONDITIONS OF CONTRACT
Page 1
1 Definitions
In this Contract the Employer means Mr. Tesfaye Alemu and the Engineer means Addis Design Consult.
14.1 Programme
The Contractor shall submit a programme within 14 days of the Commencement Date.
Page 2
14.3 Extension of Time for Completion
The Contractor is entitled to an extension of the Time for Completion if completion is delayed by exceptionally adverse climatic conditions, by any delay caused by the Employer, or by late drawings or instructions from the Engineer.
The Contractor shall give notice to the Engineer not later than 28 days after he became aware of the event giving rise to the claim.
16.2 Payment
The Employer shall pay the amount certified in each Interim Payment Certificate within 30 days after the Engineer receives the statement.
`;

const SPECIFICATION = `SECTION 3: CONCRETE WORKS
3.1 Cement
Cement shall be Ordinary Portland Cement complying with ES 1177.
3.2 Concrete for foundations and columns
Concrete for foundations and columns shall be grade C25 with a minimum cement content of 350 kg per cubic metre. Concrete shall be cured for at least 7 days.
`;

describe("chunking", () => {
  it("splits at clause headings and keeps clause numbers and pages", () => {
    const sections = splitIntoSections(CONTRACT);
    expect(sections.map((s) => [s.clause, s.heading, s.page])).toEqual([
      // The title comes before the first page marker.
      [null, null, null],
      ["1", "Definitions", 1],
      ["14.1", "Programme", 1],
      ["14.3", "Extension of Time for Completion", 2],
      ["16.2", "Payment", 2],
    ]);
    expect(splitIntoSections(SPECIFICATION).map((s) => s.clause)).toEqual(["3", "3.1", "3.2"]);
  });

  it("cuts long clauses with overlap and repeats the heading", () => {
    const long = `14.3 Extension of Time\n${"The Contractor shall keep records of the delay. ".repeat(80)}`;
    const chunks = chunkSections(splitIntoSections(long), 800, 100);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.clause === "14.3")).toBe(true);
    expect(chunks[1]!.text.startsWith("14.3 Extension of Time (continued)")).toBe(true);
    expect(chunks.every((c) => c.text.length <= 900)).toBe(true);
  });

  it("finds clauses named in a question and builds a text query", () => {
    expect(clausesMentioned("What does clause 14.3 say, and sub-clause 16.2?")).toEqual(["14.3", "16.2"]);
    expect(textQuery("What concrete grade for the columns?")).toBe("concrete | grade | columns");
    expect(textQuery("the of a")).toBeNull();
  });
});

describe("documents and Ask SiteMate", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ SITE_BATCH_SECONDS: "0" }, { now: () => new Date("2026-01-08T14:30:00Z") });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => {
    t.llm.reset();
    t.telegram.reset();
  });

  async function upload(auth: Record<string, string>, projectId: string, title: string, kind: string, text: string, mimeType = "text/plain") {
    const response = await t.app.inject({
      method: "POST",
      url: `/projects/${projectId}/documents`,
      headers: auth,
      payload: { title, kind, fileName: `${title}.txt`, mimeType, contentBase64: Buffer.from(text).toString("base64") },
    });
    expect(response.statusCode).toBe(202);
    await t.runtime.runner.drain();
    return response.json().document as { id: string };
  }

  async function projectWithDocuments() {
    const site = await setupSiteProject(t);
    const pm = await addLinkedUser(t, site.owner.auth, { name: "Sara", role: "project_manager", projectId: site.projectId });
    await upload(site.owner.auth, site.projectId, "Conditions of Contract", "contract", CONTRACT);
    await upload(site.owner.auth, site.projectId, "Specification", "specification", SPECIFICATION);
    return { site, pm };
  }

  /** Answers like a careful model: cites the source that contains the key words. */
  function answerer() {
    t.llm.when("project controls assistant of a building contractor", (request: { parts: Array<{ text?: string }> }) => {
      const prompt = request.parts[0]!.text!;
      const source = /\[(S\d+)\] Conditions of Contract, clause 14\.3/.exec(prompt);
      if (/notice/i.test(prompt.split("Question:")[1] ?? "") && source) {
        return { found: true, answer: "Notice must reach the Engineer within 28 days of becoming aware of the event.", citations: [source[1], "S99"] };
      }
      return { found: false, answer: "The documents do not say.", citations: [] };
    });
  }

  it("indexes uploaded documents and searches them by meaning and by exact clause", async () => {
    const { site } = await projectWithDocuments();
    const listed = (await t.app.inject({ url: `/projects/${site.projectId}/documents`, headers: site.owner.auth })).json().documents;
    expect(listed.map((d: { title: string; status: string; chunks: number }) => [d.title, d.status, d.chunks > 0])).toEqual([
      ["Specification", "indexed", true],
      ["Conditions of Contract", "indexed", true],
    ]);

    const byMeaning = await t.app.inject({
      url: `/projects/${site.projectId}/documents/search?q=${encodeURIComponent("how many days notice for an extension of time")}`,
      headers: site.owner.auth,
    });
    expect(byMeaning.json().results[0]).toMatchObject({ clause: "14.3", documentTitle: "Conditions of Contract", page: 2 });

    const byClause = await t.app.inject({
      url: `/projects/${site.projectId}/documents/search?q=${encodeURIComponent("what is in clause 16.2")}`,
      headers: site.owner.auth,
    });
    expect(byClause.json().results[0].clause).toBe("16.2");

    const grade = await t.app.inject({ url: `/projects/${site.projectId}/documents/search?q=C25`, headers: site.owner.auth });
    expect(grade.json().results[0].clause).toBe("3.2");
  });

  it("answers with sources it was given, and only those", async () => {
    const { site } = await projectWithDocuments();
    answerer();
    const answer = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/ask`,
      headers: site.owner.auth,
      payload: { question: "How many days do we have to give notice of a delay claim?" },
    });
    expect(answer.json()).toEqual({
      found: true,
      answer: "Notice must reach the Engineer within 28 days of becoming aware of the event.",
      sources: [{ id: expect.stringMatching(/^S\d$/), label: "Conditions of Contract, clause 14.3, page 2", ref: expect.stringMatching(/^chunk:/) }],
    });

    const unknown = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/ask`,
      headers: site.owner.auth,
      payload: { question: "Who supplies the lift?" },
    });
    expect(unknown.json()).toMatchObject({ found: false, sources: [] });
  });

  it("answers the project manager's questions on Telegram", async () => {
    const { pm } = await projectWithDocuments();
    answerer();
    await deliver(t, textUpdate(pm.telegramId, "What is the notice period for delay claims?"));
    expect(t.telegram.textsTo(pm.telegramId).at(-1)).toBe(
      "Notice must reach the Engineer within 28 days of becoming aware of the event.\n\nSources: Conditions of Contract, clause 14.3, page 2",
    );
  });

  it("flags reported work that conflicts with the specification", async () => {
    const { site, pm } = await projectWithDocuments();
    t.llm.when("site agent of SiteMate", {
      summary: "Poured the foundations with C20 concrete.",
      weather: null,
      workers: [],
      progress: [{ activityCode: "A20", percentComplete: 40, quantityDone: 16, note: "C20 used" }],
      materialsReceived: [],
      materialsUsed: [],
      issues: [],
      photoChecks: [],
      missing: [],
      followUpQuestion: null,
      confidence: 0.9,
    });
    t.llm.when("compare what a site supervisor reported", (request: { parts: Array<{ text?: string }> }) => {
      const source = /\[(S\d+)\] Specification, clause 3\.2/.exec(request.parts[0]!.text!);
      return {
        conflicts: source
          ? [{ activityCode: "A20", reported: "Foundations poured with C20 concrete", requirement: "grade C25", sourceId: source[1] }]
          : [],
      };
    });
    await deliver(t, textUpdate(site.supervisor.telegramId, "Foundations poured with C20"));
    expect(t.telegram.textsTo(pm.telegramId).at(-1)).toBe(
      "Daily log Thu, 8 Jan 2026: Foundations poured with C20 concrete. Specification, clause 3.2 requires: grade C25. Please check before the work is covered up.",
    );
  });

  it("reads PDFs through the model and records failures", async () => {
    const site = await setupSiteProject(t);
    t.llm.when("convert a construction contract", {
      sections: [{ clause: "5.1", heading: "Working hours", page: 3, text: "5.1 Working hours\nWork on site is allowed from 07:00 to 18:00, Monday to Saturday." }],
    });
    const pdf = await upload(site.owner.auth, site.projectId, "Site rules", "other", "%PDF-1.7 fake", "application/pdf");
    const [indexed] = await t.handle.db.select().from(documents).where(eq(documents.id, pdf.id));
    expect(indexed!.status).toBe("indexed");

    t.llm.reset();
    const broken = await upload(site.owner.auth, site.projectId, "Unreadable", "other", "%PDF-1.7 broken", "application/pdf");
    const [failed] = await t.handle.db.select().from(documents).where(eq(documents.id, broken.id));
    expect(failed!.status).toBe("failed");

    // Once the model can read it, the document can be read again from the dashboard.
    t.llm.when("convert a construction contract", { sections: [{ clause: "1", heading: "Scope", page: 1, text: "1 Scope\nThe works." }] });
    const again = await t.app.inject({ method: "POST", url: `/projects/${site.projectId}/documents/${broken.id}/read`, headers: site.owner.auth });
    expect(again.statusCode).toBe(202);
    await t.runtime.runner.drain();
    const [read] = await t.handle.db.select().from(documents).where(eq(documents.id, broken.id));
    expect(read!.status).toBe("indexed");
    const twice = await t.app.inject({ method: "POST", url: `/projects/${site.projectId}/documents/${broken.id}/read`, headers: site.owner.auth });
    expect(twice.statusCode).toBe(409);
  });

  it("refuses unsupported files", async () => {
    const site = await setupSiteProject(t);
    const response = await t.app.inject({
      method: "POST",
      url: `/projects/${site.projectId}/documents`,
      headers: site.owner.auth,
      payload: { title: "Drawing", kind: "other", fileName: "a.dwg", mimeType: "application/acad", contentBase64: "AAAA" },
    });
    expect(response.statusCode).toBe(400);
  });
});
