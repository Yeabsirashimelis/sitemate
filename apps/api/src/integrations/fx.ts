import { z } from "zod";

export interface ExchangeRates {
  /** Converts an amount in `currency` to Ethiopian birr. */
  toEtb(amount: number, currency: string): Promise<number>;
}

const response = z.object({ result: z.literal("success"), rates: z.record(z.string(), z.number()) });

/**
 * open.er-api.com daily rates, free and keyless. Rates are cached for a few
 * hours since they only change once a day.
 */
export class OpenExchangeRates implements ExchangeRates {
  private cache: { rates: Record<string, number>; fetchedAt: number } | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 6 * 60 * 60 * 1000,
  ) {}

  private async rates(): Promise<Record<string, number>> {
    if (this.cache && Date.now() - this.cache.fetchedAt < this.ttlMs) return this.cache.rates;
    const res = await this.fetchImpl("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Exchange rate service answered ${res.status}`);
    const { rates } = response.parse(await res.json());
    this.cache = { rates, fetchedAt: Date.now() };
    return rates;
  }

  async toEtb(amount: number, currency: string): Promise<number> {
    const code = currency.toUpperCase();
    if (code === "ETB") return amount;
    const rates = await this.rates();
    const from = rates[code];
    const etb = rates.ETB;
    if (!from || !etb) throw new Error(`No exchange rate for ${code}`);
    return Math.round((amount / from) * etb * 100) / 100;
  }
}
