import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isUrlReachable, getValidatedListingUrl, _clearUrlValidationCacheForTests } = require("./urlValidator") as typeof import("./urlValidator");

beforeEach(() => _clearUrlValidationCacheForTests());

test("isUrlReachable returns true for a 200 response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200 }) as Response);
  assert.equal(await isUrlReachable("https://watchfacts.com/flash-sales/real-one"), true);
});

test("required regression: isUrlReachable returns false for a 5xx server error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 500 }) as Response);
  assert.equal(await isUrlReachable("https://watchfacts.com/flash-sales/broken"), false);
});

test("isUrlReachable returns false for a 404", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 }) as Response);
  assert.equal(await isUrlReachable("https://watchfacts.com/flash-sales/gone"), false);
});

test("isUrlReachable retries with GET when HEAD returns 405, rather than concluding the URL is broken", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    calls++;
    if (init?.method === "HEAD") return { ok: false, status: 405 } as Response;
    return { ok: true, status: 200 } as Response;
  });
  assert.equal(await isUrlReachable("https://watchfacts.com/flash-sales/head-unsupported"), true);
  assert.equal(calls, 2);
});

test("isUrlReachable returns false (never throws) on a network error or timeout", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network down");
  });
  assert.equal(await isUrlReachable("https://watchfacts.com/flash-sales/unreachable"), false);
});

test("required regression: a URL's result is cached, so an identical check within the TTL never calls fetch again", async (t) => {
  const spy = t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200 }) as Response);
  const url = "https://watchfacts.com/flash-sales/cached";
  await isUrlReachable(url);
  await isUrlReachable(url);
  await isUrlReachable(url);
  assert.equal(spy.mock.callCount(), 1);
});

test("getValidatedListingUrl returns undefined for a missing url without calling fetch", async (t) => {
  const spy = t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200 }) as Response);
  assert.equal(await getValidatedListingUrl(undefined), undefined);
  assert.equal(spy.mock.callCount(), 0);
});

test("required regression: getValidatedListingUrl omits a broken link rather than returning it", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 500 }) as Response);
  assert.equal(await getValidatedListingUrl("https://watchfacts.com/flash-sales/broken"), undefined);
});

test("getValidatedListingUrl returns the URL unchanged when it's reachable", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200 }) as Response);
  const url = "https://watchfacts.com/flash-sales/real-one";
  assert.equal(await getValidatedListingUrl(url), url);
});
