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

test("a link is checked the way a browser opens it — GET — so a page that answers HEAD 200 but renders 500 is NOT approved", async (t) => {
  // The live case: watchfacts.com/flash-sales/<id> passed a HEAD check, then opened to
  // "500 | SERVER ERROR". A HEAD says nothing about whether the page will render.
  const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    methods.push(String(init?.method));
    if (init?.method === "HEAD") return { ok: true, status: 200 } as Response;
    return { ok: false, status: 500 } as Response;
  });
  assert.equal(await isUrlReachable("https://watchfacts.com/flash-sales/27e19db8-2db5-44b4-8e5d-71abb293131e"), false);
  assert.deepEqual(methods, ["GET"], "exactly one request, and it is the one a visitor's browser would make");
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
