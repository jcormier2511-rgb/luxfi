import { test } from "node:test";
import assert from "node:assert/strict";
import { reverseGeocode } from "./reverseGeocode";

test("resolves coordinates to a \"City, Country\" string using Nominatim's response", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    assert.match(url, /nominatim\.openstreetmap\.org\/reverse/);
    assert.match(url, /lat=25\.7617/);
    assert.match(url, /lon=-80\.1918/);
    assert.equal((init?.headers as Record<string, string>)?.["User-Agent"], "FiWatchBot/1.0 (+https://watchfacts.com)");
    return new Response(JSON.stringify({ address: { city: "Miami", state: "Florida", country: "United States" } }), { status: 200 });
  });
  const result = await reverseGeocode({ latitude: 25.7617, longitude: -80.1918 });
  assert.equal(result, "Miami, United States");
});

test("falls back to town, then village, then county/state when a finer-grained field is missing", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ address: { town: "Cooperstown", country: "United States" } }), { status: 200 })
  );
  assert.equal(await reverseGeocode({ latitude: 1, longitude: 1 }), "Cooperstown, United States");
});

test("required: returns null (never throws) when Nominatim returns a non-2xx status", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("rate limited", { status: 429 }));
  assert.equal(await reverseGeocode({ latitude: 1, longitude: 1 }), null);
});

test("required: returns null when the request itself throws (network error/timeout)", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network down");
  });
  assert.equal(await reverseGeocode({ latitude: 1, longitude: 1 }), null);
});

test("required: returns null rather than a guess when the response carries no address at all (open water)", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({}), { status: 200 }));
  assert.equal(await reverseGeocode({ latitude: 0, longitude: 0 }), null);
});

test("required: returns null when the address has neither a place name nor a country to report", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ address: {} }), { status: 200 }));
  assert.equal(await reverseGeocode({ latitude: 1, longitude: 1 }), null);
});
