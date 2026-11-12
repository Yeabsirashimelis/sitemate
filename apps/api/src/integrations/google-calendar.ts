import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

/** An all-day event. `end` is exclusive, as Google expects. */
export interface CalendarEvent {
  summary: string;
  description: string;
  start: string;
  end: string;
  /** Google's event colour, "1" to "11". */
  colorId?: string;
}

export interface CalendarProvider {
  /** Creates the event with this id, or replaces it if it already exists. */
  upsert(eventId: string, event: CalendarEvent): Promise<void>;
  /** Deletes the event. An event that is already gone is not an error. */
  remove(eventId: string): Promise<void>;
}

const serviceAccount = z.object({
  client_email: z.string(),
  private_key: z.string(),
  token_uri: z.string().default("https://oauth2.googleapis.com/token"),
});
type ServiceAccount = z.infer<typeof serviceAccount>;

export async function loadServiceAccount(path: string): Promise<ServiceAccount> {
  return serviceAccount.parse(JSON.parse(await readFile(path, "utf8")));
}

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3";

export class GoogleCalendarError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`Google Calendar ${status}: ${message}`);
  }
}

/**
 * Google Calendar through a service account that the calendar has been
 * shared with ("Make changes to events"). Signs its own token, so it needs
 * no Google SDK.
 */
export class GoogleCalendar implements CalendarProvider {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly calendarId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async upsert(eventId: string, event: CalendarEvent): Promise<void> {
    const body = {
      id: eventId,
      summary: event.summary,
      description: event.description,
      start: { date: event.start },
      end: { date: event.end },
      status: "confirmed",
      transparency: "transparent",
      ...(event.colorId ? { colorId: event.colorId } : {}),
    };
    const updated = await this.request("PUT", `/events/${eventId}`, body);
    if (updated.status !== 404) return this.check(updated);
    // Not there yet: create it with our id. A 409 means a parallel sync won the race.
    const created = await this.request("POST", "/events", body);
    if (created.status !== 409) await this.check(created);
  }

  async remove(eventId: string): Promise<void> {
    const response = await this.request("DELETE", `/events/${eventId}`);
    if (response.status === 404 || response.status === 410) return;
    await this.check(response);
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${API}/calendars/${encodeURIComponent(this.calendarId)}${path}`;
    return this.fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  }

  private async check(response: Response): Promise<void> {
    if (response.ok) return;
    const detail = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new GoogleCalendarError(response.status, detail?.error?.message ?? response.statusText);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: this.account.client_email, scope: SCOPE, aud: this.account.token_uri, iat: now, exp: now + 3600 })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.account.private_key).toString("base64url");

    const response = await this.fetchImpl(this.account.token_uri, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(15_000),
    });
    const parsed = z.object({ access_token: z.string(), expires_in: z.number() }).safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success) throw new GoogleCalendarError(response.status, "could not get an access token for the service account");
    this.token = { value: parsed.data.access_token, expiresAt: Date.now() + parsed.data.expires_in * 1000 };
    return this.token.value;
  }
}
