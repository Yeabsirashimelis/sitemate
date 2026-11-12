import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activities, approvals, projects } from "../src/db/schema.js";
import { weatherRisk } from "../src/domain/weather-rules.js";
import { checkWeather, queueMorningWeatherChecks } from "../src/features/weather.js";
import { OpenMeteo, type DailyForecast, type WeatherProvider } from "../src/integrations/open-meteo.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { addLinkedUser, setupSiteProject } from "./helpers/fixtures.js";

const dry = (date: string): DailyForecast => ({ date, precipitationMm: 0, precipitationProbability: 5, windKmh: 12 });

class FakeWeather implements WeatherProvider {
  days: DailyForecast[] = [];
  calls = 0;
  async forecast() {
    this.calls++;
    return this.days;
  }
}

describe("weather rules", () => {
  it("knows which weather stops which work", () => {
    const rain = { date: "2026-01-08", precipitationMm: 12, precipitationProbability: 90, windKmh: 10 };
    expect(weatherRisk("concrete_pour", rain)).toBe("12.0 mm of rain (90% chance)");
    expect(weatherRisk("masonry", rain)).toBeNull();
    expect(weatherRisk("general", rain)).toBeNull();
    expect(weatherRisk("concrete_pour", { ...rain, precipitationMm: 3, precipitationProbability: 75 })).not.toBeNull();
    expect(weatherRisk("concrete_pour", { ...rain, precipitationMm: 1, precipitationProbability: 75 })).toBeNull();
    expect(weatherRisk("roofing", { ...rain, precipitationMm: 0, windKmh: 46 })).toBe("wind up to 46 km/h");
  });
});

describe("Open-Meteo client", () => {
  it("asks for the daily fields and maps the answer", async () => {
    let requested = "";
    const fakeFetch = (async (url: URL) => {
      requested = url.toString();
      return new Response(
        JSON.stringify({
          daily: {
            time: ["2026-11-12", "2026-11-13"],
            precipitation_sum: [3.6, null],
            precipitation_probability_max: [81, 48],
            wind_speed_10m_max: [14.1, 17.1],
          },
        }),
      );
    }) as unknown as typeof fetch;
    const days = await new OpenMeteo(fakeFetch).forecast(8.9956, 38.7869, 2, "Africa/Addis_Ababa");
    expect(requested).toContain("daily=precipitation_sum%2Cprecipitation_probability_max%2Cwind_speed_10m_max");
    expect(requested).toContain("timezone=Africa%2FAddis_Ababa");
    expect(days).toEqual([
      { date: "2026-11-12", precipitationMm: 3.6, precipitationProbability: 81, windKmh: 14.1 },
      { date: "2026-11-13", precipitationMm: 0, precipitationProbability: 48, windKmh: 17.1 },
    ]);
  });
});

describe("morning weather check", () => {
  let t: TestApp;
  const weather = new FakeWeather();
  // 04:00 UTC is 07:00 in Addis Ababa.
  let now = new Date("2026-01-07T04:00:00Z");

  beforeAll(async () => {
    t = await createTestApp({}, { now: () => now, weather });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => {
    now = new Date("2026-01-07T04:00:00Z");
    t.telegram.reset();
  });

  it("asks to hold a concrete pour planned on a rainy day and applies the hold when approved", async () => {
    const site = await setupSiteProject(t);
    const pm = await addLinkedUser(t, site.owner.auth, { name: "Sara", role: "project_manager", projectId: site.projectId });
    // A20 Foundations (concrete) is planned to start on 8 January.
    weather.days = [dry("2026-01-07"), { date: "2026-01-08", precipitationMm: 12, precipitationProbability: 90, windKmh: 10 }, dry("2026-01-09"), dry("2026-01-10")];

    const findings = await checkWeather(t.runtime.deps, site.projectId);
    expect(findings).toEqual([{ activityCode: "A20", date: "2026-01-08", risk: "12.0 mm of rain (90% chance)", action: "proposed_hold" }]);

    const [approval] = await t.handle.db.select().from(approvals).where(eq(approvals.projectId, site.projectId));
    expect(approval!.title).toBe("Hold A20 Foundations until Fri, 9 Jan 2026?");
    expect(approval!.summary).toContain("Open-Meteo forecasts 12.0 mm of rain (90% chance) on Thu, 8 Jan 2026");
    expect(approval!.summary).toContain("moves the forecast handover by 1 workday");

    const decision = await t.app.inject({
      method: "POST",
      url: `/approvals/${approval!.id}/decision`,
      headers: pm.auth!,
      payload: { decision: "approve" },
    });
    expect(decision.json().approval.status).toBe("executed");
    const [a20] = await t.handle.db
      .select()
      .from(activities)
      .where(and(eq(activities.projectId, site.projectId), eq(activities.code, "A20")));
    expect(a20!.startNoEarlierThan).toBe("2026-01-09");

    // Running the check again the same morning does not ask twice.
    expect((await checkWeather(t.runtime.deps, site.projectId)).map((f) => f.action)).not.toContain("proposed_hold");
  });

  it("warns instead when the work is already under way", async () => {
    const site = await setupSiteProject(t);
    const pm = await addLinkedUser(t, site.owner.auth, { name: "Sara", role: "project_manager", projectId: site.projectId });
    await t.handle.db
      .update(activities)
      .set({ actualStart: "2026-01-05", remainingDuration: 2 })
      .where(and(eq(activities.projectId, site.projectId), eq(activities.code, "A10")));
    await t.handle.db.update(projects).set({ dataDate: "2026-01-07" }).where(eq(projects.id, site.projectId));
    weather.days = [{ date: "2026-01-07", precipitationMm: 22, precipitationProbability: 95, windKmh: 10 }, dry("2026-01-08"), dry("2026-01-09"), dry("2026-01-10")];

    const findings = await checkWeather(t.runtime.deps, site.projectId);
    expect(findings.find((f) => f.activityCode === "A10")?.action).toBe("warned");
    expect(t.telegram.textsTo(pm.telegramId).at(-1)).toMatch(/22\.0 mm of rain .* while A10 Excavation is under way/);
  });

  it("queues one check per site each morning after 06:30", async () => {
    await setupSiteProject(t);
    now = new Date("2026-01-08T02:00:00Z"); // 05:00 local
    expect(await queueMorningWeatherChecks(t.runtime.deps)).toBe(0);
    now = new Date("2026-01-08T04:00:00Z"); // 07:00 local
    expect(await queueMorningWeatherChecks(t.runtime.deps)).toBeGreaterThan(0);
    expect(await queueMorningWeatherChecks(t.runtime.deps)).toBe(0);
  });
});
