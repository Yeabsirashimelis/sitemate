import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calendarEvents, projects, rfis } from "../src/db/schema.js";
import { eventId, queueCalendarSyncs, syncProjectCalendar } from "../src/features/calendar.js";
import { GoogleCalendar, type CalendarEvent, type CalendarProvider } from "../src/integrations/google-calendar.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { setupSiteProject } from "./helpers/fixtures.js";

class FakeCalendar implements CalendarProvider {
  events = new Map<string, CalendarEvent>();
  writes = 0;
  async upsert(id: string, event: CalendarEvent) {
    this.writes++;
    this.events.set(id, event);
  }
  async remove(id: string) {
    this.writes++;
    this.events.delete(id);
  }
  summaries() {
    return [...this.events.values()].map((e) => e.summary).sort();
  }
}

describe("calendar sync", () => {
  let t: TestApp;
  const calendar = new FakeCalendar();
  const now = new Date("2026-01-07T06:00:00Z");

  beforeAll(async () => {
    t = await createTestApp({}, { now: () => now, calendar });
  });
  afterAll(async () => {
    await t.close();
  });

  it("puts the look-ahead, handover and deadlines on the calendar and only sends changes", async () => {
    const site = await setupSiteProject(t);
    await t.handle.db.insert(rfis).values({ projectId: site.projectId, number: 7, question: "Which rebar grade for the columns?", status: "sent", raisedOn: "2026-01-06", dueOn: "2026-01-10" });

    const first = await syncProjectCalendar(t.runtime.deps, site.projectId);
    expect(first!.created).toBeGreaterThan(2);
    expect(first!.updated + first!.removed).toBe(0);
    const summaries = calendar.summaries();
    expect(summaries).toContain("Contract completion (Bole G+4 Apartments)");
    expect(summaries).toContain("RFI 7 answer due (Bole G+4 Apartments)");
    expect(summaries.some((s) => /^(Blocked: |At risk: )?A20 Foundations/.test(s))).toBe(true);

    const contract = calendar.events.get(eventId(site.projectId, "contract-finish"))!;
    expect(contract).toMatchObject({ start: "2026-01-18", end: "2026-01-19" });

    // Nothing changed, nothing sent.
    const writes = calendar.writes;
    const second = await syncProjectCalendar(t.runtime.deps, site.projectId);
    expect(second).toMatchObject({ created: 0, updated: 0, removed: 0 });
    expect(calendar.writes).toBe(writes);

    // The RFI is answered: its reminder goes; the contract date moves: that event is updated in place.
    await t.handle.db.update(rfis).set({ status: "answered", answer: "B500", answeredOn: "2026-01-08" }).where(eq(rfis.projectId, site.projectId));
    await t.handle.db.update(projects).set({ contractFinish: "2026-01-25" }).where(eq(projects.id, site.projectId));
    const third = await syncProjectCalendar(t.runtime.deps, site.projectId);
    expect(third).toMatchObject({ removed: 1 });
    expect(third!.updated).toBeGreaterThanOrEqual(1);
    expect(calendar.summaries()).not.toContain("RFI 7 answer due (Bole G+4 Apartments)");
    expect(calendar.events.get(eventId(site.projectId, "contract-finish"))).toMatchObject({ start: "2026-01-25" });

    // A closed project leaves the calendar.
    await t.handle.db.update(projects).set({ active: false }).where(eq(projects.id, site.projectId));
    await syncProjectCalendar(t.runtime.deps, site.projectId);
    expect(await t.handle.db.select().from(calendarEvents).where(eq(calendarEvents.projectId, site.projectId))).toHaveLength(0);
    expect(calendar.summaries().filter((s) => s.includes("Bole"))).toHaveLength(0);
  });

  it("queues one sync per project per hour", async () => {
    await setupSiteProject(t);
    expect(await queueCalendarSyncs(t.runtime.deps)).toBeGreaterThan(0);
    expect(await queueCalendarSyncs(t.runtime.deps)).toBe(0);
  });

  it("makes event ids Google accepts", () => {
    expect(eventId("0b7c2f3e-4d6a-4f1b-9c8d-1a2b3c4d5e6f", "activity:B2100")).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(eventId("p", "a")).not.toBe(eventId("p", "b"));
  });

  it("refuses a manual sync when no calendar is connected", async () => {
    const plain = await createTestApp();
    try {
      const site = await setupSiteProject(plain);
      const status = await plain.app.inject({ method: "GET", url: `/projects/${site.projectId}/calendar`, headers: site.owner.auth });
      expect(status.json()).toMatchObject({ connected: false, events: 0 });
      const sync = await plain.app.inject({ method: "POST", url: `/projects/${site.projectId}/calendar/sync`, headers: site.owner.auth });
      expect(sync.statusCode).toBe(409);
    } finally {
      await plain.close();
    }
  });
});

describe("Google Calendar client", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = { client_email: "sync@example.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), token_uri: "https://oauth2.example/token" };

  function fakeGoogle(responses: Record<string, number>) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      if (url === account.token_uri) {
        calls.push("token");
        return new Response(JSON.stringify({ access_token: "token-1", expires_in: 3600 }));
      }
      const path = new URL(url).pathname.replace(/^.*\/events/, "/events");
      calls.push(`${method} ${path}`);
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-1");
      const status = responses[`${method} ${path}`] ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(status >= 400 ? { error: { message: "nope" } } : {}), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  const event: CalendarEvent = { summary: "A20 Foundations", description: "", start: "2026-01-08", end: "2026-01-10" };

  it("creates the event when it is not there yet and reuses the token", async () => {
    const google = fakeGoogle({ "PUT /events/smabc": 404 });
    const client = new GoogleCalendar(account, "team@group.calendar.google.com", google.fetchImpl);
    await client.upsert("smabc", event);
    await client.remove("smabc");
    expect(google.calls).toEqual(["token", "PUT /events/smabc", "POST /events", "DELETE /events/smabc"]);
  });

  it("treats a missing event on delete as done and reports real failures", async () => {
    const google = fakeGoogle({ "DELETE /events/gone": 410, "PUT /events/locked": 403 });
    const client = new GoogleCalendar(account, "team@group.calendar.google.com", google.fetchImpl);
    await expect(client.remove("gone")).resolves.toBeUndefined();
    await expect(client.upsert("locked", event)).rejects.toThrow("Google Calendar 403: nope");
  });
});
