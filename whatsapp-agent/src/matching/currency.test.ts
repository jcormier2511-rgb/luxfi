import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { convertMoneyToUsd, detectCurrency, formatOriginalAndUsd, parseMoney, setExchangeRateProviderForTests } from "./currency";

afterEach(() => setExchangeRateProviderForTests());

test("recognizes every required currency and preserves grouped amounts", () => {
  const examples = [
    ["$110,000", "USD"], ["HKD 110,000", "HKD"], ["€110,000", "EUR"], ["£110,000", "GBP"],
    ["AED 110,000", "AED"], ["CHF 110,000", "CHF"], ["CAD 110,000", "CAD"],
    ["SGD 110,000", "SGD"], ["S$110,000", "SGD"],
    ["AUD 110,000", "AUD"], ["A$110,000", "AUD"],
    ["JPY 110,000", "JPY"], ["CNY 110,000", "CNY"], ["RMB 110,000", "CNY"],
  ] as const;
  for (const [raw, currency] of examples) {
    assert.deepEqual(parseMoney(raw), { amount: 110000, currency });
    assert.equal(detectCurrency(raw), currency);
  }
});

test("converts to USD and caches the mocked provider rate", async () => {
  let calls = 0;
  setExchangeRateProviderForTests(async (currency) => {
    calls += 1;
    return currency === "HKD" ? 0.128 : null;
  });
  assert.equal(await convertMoneyToUsd({ amount: 820000, currency: "HKD" }), 104960);
  assert.equal(await convertMoneyToUsd({ amount: 900000, currency: "HKD" }), 115200);
  assert.equal(calls, 1, "the second conversion must use the cached HKD rate");
});

test("an unavailable conversion returns null rather than equating unlike currencies", async () => {
  setExchangeRateProviderForTests(async () => null);
  assert.equal(await convertMoneyToUsd({ amount: 105000, currency: "AED" }), null);
});

test("displays original and converted amounts with symbols and grouping", () => {
  assert.equal(formatOriginalAndUsd({ amount: 820000, currency: "HKD" }, 104960), "HK$820,000 (USD $104,960)");
  assert.equal(formatOriginalAndUsd({ amount: 105000, currency: "USD" }, 105000), "$105,000 (USD $105,000)");
  assert.equal(formatOriginalAndUsd({ amount: 110000, currency: "SGD" }, 82500), "S$110,000 (USD $82,500)");
});
