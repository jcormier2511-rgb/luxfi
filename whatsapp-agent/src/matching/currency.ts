import { normalizePriceShorthand } from "../postings/normalize";

export const SUPPORTED_CURRENCIES = ["USD", "HKD", "EUR", "GBP", "AED", "CHF", "CAD", "JPY", "CNY"] as const;
export type CurrencyCode = typeof SUPPORTED_CURRENCIES[number];

export interface Money {
  amount: number;
  currency: CurrencyCode;
}

export type ExchangeRateProvider = (currency: CurrencyCode) => Promise<number | null>;

const SYMBOLS: Record<CurrencyCode, string> = {
  USD: "$", HKD: "HK$", EUR: "€", GBP: "£", AED: "AED ", CHF: "CHF ", CAD: "C$", JPY: "¥", CNY: "CN¥",
};
const RATE_TTL_MS = 60 * 60 * 1000;
const rateCache = new Map<CurrencyCode, { rate: number; expiresAt: number }>();
const pendingRates = new Map<CurrencyCode, Promise<number | null>>();

const defaultRateProvider: ExchangeRateProvider = async (currency) => {
  if (currency === "USD") return 1;
  const response = await fetch("https://open.er-api.com/v6/latest/USD");
  if (!response.ok) return null;
  const body = await response.json() as { rates?: Record<string, number> };
  const unitsPerUsd = body.rates?.[currency];
  return unitsPerUsd && Number.isFinite(unitsPerUsd) ? 1 / unitsPerUsd : null;
};

let rateProvider: ExchangeRateProvider = defaultRateProvider;

export function setExchangeRateProviderForTests(provider?: ExchangeRateProvider): void {
  rateProvider = provider ?? defaultRateProvider;
  rateCache.clear();
  pendingRates.clear();
}

export function detectCurrency(raw: string, fallback: CurrencyCode = "USD"): CurrencyCode | null {
  const upper = raw.toUpperCase();
  if (/\b(?:CNY|RMB)\b|CN¥/i.test(raw)) return "CNY";
  for (const code of SUPPORTED_CURRENCIES) if (new RegExp(`\\b${code}\\b`, "i").test(upper)) return code;
  if (/HK\$/i.test(raw)) return "HKD";
  if (/C\$/i.test(raw)) return "CAD";
  if (/€/.test(raw)) return "EUR";
  if (/£/.test(raw)) return "GBP";
  if (/د\.?إ|دإ/.test(raw)) return "AED";
  if (/¥/.test(raw)) return "JPY";
  if (/\$/.test(raw)) return "USD";
  return fallback;
}

export function parseMoney(raw: string, fallback: CurrencyCode = "USD"): Money | null {
  const amount = normalizePriceShorthand(raw);
  const currency = detectCurrency(raw, fallback);
  return amount === null || !currency ? null : { amount, currency };
}

export async function getUsdRate(currency: CurrencyCode): Promise<number | null> {
  if (currency === "USD") return 1;
  const cached = rateCache.get(currency);
  if (cached && cached.expiresAt > Date.now()) return cached.rate;
  const inFlight = pendingRates.get(currency);
  if (inFlight) return inFlight;
  const request = rateProvider(currency)
    .then((rate) => {
      if (!rate || !Number.isFinite(rate) || rate <= 0) return null;
      rateCache.set(currency, { rate, expiresAt: Date.now() + RATE_TTL_MS });
      return rate;
    })
    .catch(() => null)
    .finally(() => pendingRates.delete(currency));
  pendingRates.set(currency, request);
  return request;
}

export async function convertMoneyToUsd(money: Money): Promise<number | null> {
  const rate = await getUsdRate(money.currency);
  return rate === null ? null : money.amount * rate;
}

export function formatMoney(money: Money): string {
  return `${SYMBOLS[money.currency]}${Math.round(money.amount).toLocaleString("en-US")}`;
}

export function formatOriginalAndUsd(money: Money, usd: number): string {
  return `${formatMoney(money)} (USD $${Math.round(usd).toLocaleString("en-US")})`;
}
