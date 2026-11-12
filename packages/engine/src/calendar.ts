/**
 * Working calendar.
 *
 * The scheduling engine works in "workday indexes": index 0 is the first
 * working day on or after the project start, index 1 the next working day,
 * and so on. This keeps the critical path maths in plain integers and leaves
 * weekends and holidays to this one class.
 *
 * Dates are ISO strings (YYYY-MM-DD) and all date maths is done in UTC so the
 * result never depends on the server's time zone.
 */

export type IsoDate = string;

export interface CalendarOptions {
  /** Weekdays that are worked, 0 = Sunday ... 6 = Saturday. Default: Monday to Saturday. */
  workingWeekdays?: readonly number[];
  /** Non-working dates, e.g. public holidays. */
  holidays?: readonly IsoDate[];
}

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(date: IsoDate): number {
  if (!ISO_DATE.test(date)) {
    throw new Error(`Invalid date "${date}", expected YYYY-MM-DD`);
  }
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid date "${date}"`);
  }
  return ms;
}

export function formatIsoDate(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addCalendarDays(date: IsoDate, days: number): IsoDate {
  return formatIsoDate(parseIsoDate(date) + days * DAY_MS);
}

export class WorkCalendar {
  readonly start: IsoDate;
  private readonly weekdays: ReadonlySet<number>;
  private readonly holidays: ReadonlySet<IsoDate>;
  /** workdays[i] is the date of workday index i. Grown on demand. */
  private readonly workdays: IsoDate[] = [];
  private readonly indexByDate = new Map<IsoDate, number>();

  constructor(projectStart: IsoDate, options: CalendarOptions = {}) {
    parseIsoDate(projectStart);
    const weekdays = options.workingWeekdays ?? [1, 2, 3, 4, 5, 6];
    if (weekdays.length === 0) {
      throw new Error("A calendar needs at least one working weekday");
    }
    for (const day of weekdays) {
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw new Error(`Invalid weekday ${day}, expected 0 to 6`);
      }
    }
    for (const holiday of options.holidays ?? []) parseIsoDate(holiday);

    this.start = projectStart;
    this.weekdays = new Set(weekdays);
    this.holidays = new Set(options.holidays ?? []);
  }

  isWorkday(date: IsoDate): boolean {
    const weekday = new Date(parseIsoDate(date)).getUTCDay();
    return this.weekdays.has(weekday) && !this.holidays.has(date);
  }

  /** Date of the workday with the given index (0 = first workday on or after the start). */
  dateOf(index: number): IsoDate {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Workday index must be a non-negative integer, got ${index}`);
    }
    this.extendTo(index);
    return this.workdays[index]!;
  }

  /**
   * Index of the workday on or after the given date. A Sunday or a holiday
   * maps to the next working day, which is what "starts on that date" means
   * on site.
   */
  indexOf(date: IsoDate): number {
    const target = parseIsoDate(date);
    if (target < parseIsoDate(this.start)) {
      throw new Error(`${date} is before the project start ${this.start}`);
    }
    const known = this.indexByDate.get(date);
    if (known !== undefined) return known;

    let index = 0;
    while (parseIsoDate(this.dateOf(index)) < target) index++;
    return index;
  }

  /** Number of workdays from `from` (inclusive) to `to` (exclusive). */
  workdaysBetween(from: IsoDate, to: IsoDate): number {
    return this.indexOf(to) - this.indexOf(from);
  }

  private extendTo(index: number): void {
    let cursor =
      this.workdays.length === 0
        ? parseIsoDate(this.start)
        : parseIsoDate(this.workdays[this.workdays.length - 1]!) + DAY_MS;

    while (this.workdays.length <= index) {
      const date = formatIsoDate(cursor);
      if (this.isWorkday(date)) {
        this.indexByDate.set(date, this.workdays.length);
        this.workdays.push(date);
      }
      cursor += DAY_MS;
    }
  }
}
