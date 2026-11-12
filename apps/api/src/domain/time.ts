/** Calendar date (YYYY-MM-DD) in a time zone. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Minutes since local midnight in a time zone. */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/** "17:30" -> 1050 */
export function parseClock(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/** True when the local hour falls inside quiet hours, which may wrap past midnight (e.g. 20 to 7). */
export function inQuietHours(now: Date, timeZone: string, from: number, to: number): boolean {
  const hour = Math.floor(localMinutes(now, timeZone) / 60);
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}
