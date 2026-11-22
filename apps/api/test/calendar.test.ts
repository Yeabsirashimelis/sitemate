import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calendarEvents, companies, projects, rfis } from "../src/db/schema.js";
import { eventId, queueCalendarSyncs, removeOrphanEvents, syncProjectCalendar } from "../src/features/calendar.js";
import { GoogleCalendar, type CalendarEvent, type CalendarProvider } from "../src/integrations/google-calendar.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { setupSiteProject } from "./helpers/fixtures.js";

const TEAM = "team@group.calendar.google.com";

/** Google Calendar in memory: one map of events per calendar, and the calendars shared with SiteMate. */
class FakeCalendar implements CalendarProvider {
  readonly accountEmail = "sitemate@example.iam.gserviceaccount.com";
  calendars = new Map<string, Map<string, CalendarEvent>>();
  shared = new Set([TEAM, "site@group.calendar.google.com"]);
  writes = 0;
  on(calendarId: string) {
    if (!this.calendars.has(calendarId)) this.calendars.set(calendarId, new Map());
    return this.calendars.get(calendarId)!;
  }
  /** The team calendar most tests look at. */
  get events() {
    return this.on(TEAM);
  }
  async upsert(calendarId: string, id: string, event: CalendarEvent) {
    this.writes++;
    this.on(calendarId).set(id, event);
  }
  async remove(calendarId: string, id: string) {
    this.writes++;
    this.on(calendarId).delete(id);
  }
  async canWrite(calendarId: string) {
    return this.shared.has(calendarId);
  }
  summaries(calendarId = TEAM) {
    return [...this.on(calendarId).values()].map((e) => e.summary).sort();
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

  async function connect(auth: Record<string, string>, calendarId: string | null) {
    const response = await t.app.inject({ method: "PUT", url: "/company/calendar", headers: auth, payload: { calendarId } });
    await t.runtime.runner.drain();
    return response;
  }

  it("puts the look-ahead, handover and deadlines on the calendar and only sends changes", async () => {
    const site = await setupSiteProject(t);
    await t.handle.db.update(companies).set({ googleCalendarId: TEAM }).where(eq(companies.id, site.owner.company.id));
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

  it("queues one sync per project per hour, only for companies with a calendar", async () => {
    await setupSiteProject(t); // no calendar connected: nothing to do
    const before = await queueCalendarSyncs(t.runtime.deps);
    const site = await setupSiteProject(t);
    await t.handle.db.update(companies).set({ googleCalendarId: TEAM }).where(eq(companies.id, site.owner.company.id));
    expect(await queueCalendarSyncs(t.runtime.deps)).toBe(1);
    expect(await queueCalendarSyncs(t.runtime.deps)).toBe(0);
    expect(before).toBe(0);
  });

  it("connects a company's own calendar, moves events when it changes, and takes them off when disconnected", async () => {
    const site = await setupSiteProject(t);
    const site2 = "site@group.calendar.google.com";

    const refused = await connect(site.owner.auth, "not-shared@group.calendar.google.com");
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toContain(calendar.accountEmail);

    expect((await connect(site.owner.auth, site2)).statusCode).toBe(200);
    const mine = (cal: string) => calendar.summaries(cal).filter((s) => s.includes("Bole") && calendar.on(cal).has(eventId(site.projectId, "contract-finish")));
    expect(mine(site2).length).toBeGreaterThan(2);
    const status = (await t.app.inject({ method: "GET", url: `/projects/${site.projectId}/calendar`, headers: site.owner.auth })).json();
    expect(status).toMatchObject({ available: true, connected: true, calendarId: site2, shareWith: calendar.accountEmail });

    // Another company's projects never land on this calendar.
    const other = await setupSiteProject(t);
    await syncProjectCalendar(t.runtime.deps, other.projectId);
    expect(calendar.on(site2).has(eventId(other.projectId, "contract-finish"))).toBe(false);

    // Switching calendars moves the events.
    await connect(site.owner.auth, TEAM);
    expect(calendar.on(site2).has(eventId(site.projectId, "contract-finish"))).toBe(false);
    expect(calendar.on(TEAM).has(eventId(site.projectId, "contract-finish"))).toBe(true);

    await connect(site.owner.auth, null);
    expect(calendar.on(TEAM).has(eventId(site.projectId, "contract-finish"))).toBe(false);
    expect(await t.handle.db.select().from(calendarEvents).where(eq(calendarEvents.projectId, site.projectId))).toHaveLength(0);
  });

  it("takes a deleted project's events off the calendar", async () => {
    const site = await setupSiteProject(t);
    await connect(site.owner.auth, TEAM);
    expect(calendar.on(TEAM).has(eventId(site.projectId, "contract-finish"))).toBe(true);

    await t.handle.db.delete(projects).where(eq(projects.id, site.projectId));
    expect(await removeOrphanEvents(t.runtime.deps)).toBeGreaterThan(2);
    expect(calendar.on(TEAM).has(eventId(site.projectId, "contract-finish"))).toBe(false);
    expect(await removeOrphanEvents(t.runtime.deps)).toBe(0);
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
      expect(status.json()).toMatchObject({ available: false, connected: false, events: 0 });
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
    const client = new GoogleCalendar(account, google.fetchImpl);
    await client.upsert(TEAM, "smabc", event);
    await client.remove(TEAM, "smabc");
    expect(google.calls).toEqual(["token", "PUT /events/smabc", "POST /events", "DELETE /events/smabc"]);
  });

  it("treats a missing event on delete as done and reports real failures", async () => {
    const google = fakeGoogle({ "DELETE /events/gone": 410, "PUT /events/locked": 403 });
    const client = new GoogleCalendar(account, google.fetchImpl);
    await expect(client.remove(TEAM, "gone")).resolves.toBeUndefined();
    await expect(client.upsert(TEAM, "locked", event)).rejects.toThrow("Google Calendar 403: nope");
  });

  it("tells whether a calendar has been shared with SiteMate", async () => {
    const google = fakeGoogle({ "GET /events": 404 });
    const client = new GoogleCalendar(account, google.fetchImpl);
    expect(await client.canWrite("someone-else@group.calendar.google.com")).toBe(false);
    expect(client.accountEmail).toBe(account.client_email);
  });
});
