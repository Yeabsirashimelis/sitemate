/**
 * When weather stops work, by activity type. The thresholds are cautious site
 * rules of thumb: fresh concrete is damaged by heavy rain, roofing sheets are
 * unsafe to fix in strong wind, and open excavations flood.
 */

import type { DailyForecast } from "../integrations/open-meteo.js";

type Kind = "general" | "excavation" | "concrete_pour" | "masonry" | "roofing" | "finishing" | "mep" | "milestone";

interface Rule {
  rainMm?: number;
  /** Rain this likely counts as a risk even below the amount above. */
  rainProbability?: { percent: number; minMm: number };
  windKmh?: number;
}

const RULES: Partial<Record<Kind, Rule>> = {
  concrete_pour: { rainMm: 5, rainProbability: { percent: 70, minMm: 2 } },
  roofing: { rainMm: 10, windKmh: 40 },
  excavation: { rainMm: 15 },
  masonry: { rainMm: 20 },
};

export function isWeatherSensitive(kind: string): boolean {
  return kind in RULES;
}

/** Why the weather on this day stops this kind of work, or null if it does not. */
export function weatherRisk(kind: string, day: DailyForecast): string | null {
  const rule = RULES[kind as Kind];
  if (!rule) return null;
  const rain = `${day.precipitationMm.toFixed(1)} mm of rain${day.precipitationProbability !== null ? ` (${day.precipitationProbability}% chance)` : ""}`;
  if (rule.rainMm !== undefined && day.precipitationMm >= rule.rainMm) return rain;
  if (
    rule.rainProbability &&
    day.precipitationProbability !== null &&
    day.precipitationProbability >= rule.rainProbability.percent &&
    day.precipitationMm >= rule.rainProbability.minMm
  ) {
    return rain;
  }
  if (rule.windKmh !== undefined && day.windKmh !== null && day.windKmh >= rule.windKmh) {
    return `wind up to ${Math.round(day.windKmh)} km/h`;
  }
  return null;
}
