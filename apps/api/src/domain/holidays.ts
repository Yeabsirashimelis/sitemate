/**
 * Ethiopian public holidays used as the default project calendar.
 *
 * Christian and national holidays follow the Ethiopian calendar and are
 * fixed or computed from Orthodox Easter. The Islamic holidays depend on the
 * moon sighting and are announced shortly before, so the dates here are the
 * expected ones and should be confirmed on each project's calendar.
 */
export const ETHIOPIAN_HOLIDAYS: Record<number, string[]> = {
  2026: [
    "2026-01-07", // Genna (Christmas)
    "2026-01-19", // Timket (Epiphany)
    "2026-03-02", // Adwa Victory Day
    "2026-03-20", // Eid al-Fitr (expected)
    "2026-04-10", // Siklet (Good Friday)
    "2026-04-12", // Fasika (Easter)
    "2026-05-01", // International Labour Day
    "2026-05-05", // Patriots' Victory Day
    "2026-05-27", // Eid al-Adha (expected)
    "2026-05-28", // Downfall of the Derg
    "2026-08-26", // Mawlid (expected)
    "2026-09-11", // Enkutatash (New Year)
    "2026-09-27", // Meskel
  ],
  2027: [
    "2027-01-07",
    "2027-01-19",
    "2027-03-02",
    "2027-03-10", // Eid al-Fitr (expected)
    "2027-04-30", // Siklet
    "2027-05-01",
    "2027-05-02", // Fasika
    "2027-05-05",
    "2027-05-17", // Eid al-Adha (expected)
    "2027-05-28",
    "2027-08-15", // Mawlid (expected)
    "2027-09-12", // Enkutatash, a day later before a Gregorian leap year
    "2027-09-28", // Meskel
  ],
};

/** Default holidays between two dates (inclusive). */
export function defaultHolidays(from: string, to: string): string[] {
  const years = Object.keys(ETHIOPIAN_HOLIDAYS).map(Number);
  return years
    .flatMap((year) => ETHIOPIAN_HOLIDAYS[year] ?? [])
    .filter((date) => date >= from && date <= to)
    .sort();
}
