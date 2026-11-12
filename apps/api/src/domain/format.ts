const birrFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 38000 -> "38,000 birr" */
export function birr(amount: number): string {
  return `${birrFormat.format(Math.round(amount))} birr`;
}

/** "2026-01-21" -> "Wed 21 Jan 2026" */
export function longDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}
