import { z } from "zod";

export interface DailyForecast {
  date: string;
  precipitationMm: number;
  precipitationProbability: number | null;
  windKmh: number | null;
}

export interface WeatherProvider {
  forecast(latitude: number, longitude: number, days: number, timeZone: string): Promise<DailyForecast[]>;
}

const response = z.object({
  daily: z.object({
    time: z.array(z.string()),
    precipitation_sum: z.array(z.number().nullable()),
    precipitation_probability_max: z.array(z.number().nullable()).optional(),
    wind_speed_10m_max: z.array(z.number().nullable()).optional(),
  }),
});

/** Open-Meteo daily forecast. Free and keyless for non-commercial use. */
export class OpenMeteo implements WeatherProvider {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://api.open-meteo.com/v1/forecast",
  ) {}

  async forecast(latitude: number, longitude: number, days: number, timeZone: string): Promise<DailyForecast[]> {
    const url = new URL(this.baseUrl);
    url.search = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      daily: "precipitation_sum,precipitation_probability_max,wind_speed_10m_max",
      timezone: timeZone,
      forecast_days: String(Math.min(Math.max(days, 1), 16)),
    }).toString();

    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
    const { daily } = response.parse(await res.json());
    return daily.time.map((date, i) => ({
      date,
      precipitationMm: daily.precipitation_sum[i] ?? 0,
      precipitationProbability: daily.precipitation_probability_max?.[i] ?? null,
      windKmh: daily.wind_speed_10m_max?.[i] ?? null,
    }));
  }
}
