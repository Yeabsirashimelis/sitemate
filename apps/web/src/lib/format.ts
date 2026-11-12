const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** 1250000 -> "1,250,000 birr" */
export function birr(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "–";
  return `${whole.format(Math.round(amount))} birr`;
}

/** Compact money for tiles: 1.25M, 380K. */
export function birrCompact(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "–";
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `${oneDecimal.format(amount / 1_000_000)}M`;
  if (abs >= 10_000) return `${whole.format(amount / 1000)}K`;
  return whole.format(amount);
}

/** Performance index (SPI, CPI): always two decimals, so 1 reads as 1.00. */
export function perfIndex(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : value.toFixed(2);
}

export function number(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return "–";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const DATE_YEAR = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

const parse = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);

/** "2027-03-20" -> "20 Mar" */
export const shortDate = (iso: string | null | undefined) => (iso ? DATE.format(parse(iso)) : "–");
/** "2027-03-20" -> "20 Mar 2027" */
export const longDate = (iso: string | null | undefined) => (iso ? DATE_YEAR.format(parse(iso)) : "–");
/** "2027-03-20" -> "Sat 20 Mar" */
export const dayDate = (iso: string | null | undefined) => (iso ? WEEKDAY.format(parse(iso)).replace(",", "") : "–");

export function relativeTime(timestamp: string | Date): string {
  const then = typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  const seconds = Math.round((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return longDate(then.toISOString());
}

export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${number(count)} ${count === 1 ? word : pluralWord}`;
}

/** Workdays late or early, the way a planner says it. */
export function slipText(slipDays: number | null | undefined): string {
  if (slipDays === null || slipDays === undefined) return "No forecast yet";
  if (slipDays === 0) return "On contract date";
  return slipDays > 0 ? `${plural(slipDays, "workday")} late` : `${plural(-slipDays, "workday")} early`;
}

export const roleLabel: Record<string, string> = {
  owner: "Owner",
  project_manager: "Project manager",
  site_engineer: "Site engineer",
  supervisor: "Supervisor",
  subcontractor: "Subcontractor",
  supplier: "Supplier",
};
