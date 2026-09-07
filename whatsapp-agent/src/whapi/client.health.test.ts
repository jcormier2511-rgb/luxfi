import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.WHAPI_TOKEN = "super-secret-whapi-token";

const client = require("./client") as typeof import("./client");

test("checkWhapiHealth reports authorized:true for a live, authorized channel and never leaks the token into the result", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://gate.whapi.cloud/health");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer super-secret-whapi-token");
    // Confirmed live against a real channel -- flat {status,channel,code}, not the nested
    // {health:{status:{code,text},version}} shape the docs/older code assumed. No version field.
    return new Response(JSON.stringify({ status: "OK", channel: "STARLD-T6W2F", code: 200 }), { status: 200 });
  });
  const result = await client.checkWhapiHealth();
  assert.equal(result.configured, true);
  assert.equal(result.reachable, true);
  assert.equal(result.authorized, true);
  assert.equal(result.statusText, "OK");
  assert.equal(result.version, null);
  assert.equal(result.error, null);
  assert.equal(JSON.stringify(result).includes("super-secret-whapi-token"), false, "the token itself must never appear in the reported result");
});

test("checkWhapiHealth reports authorized:false for a non-OK status (e.g. waiting on a QR scan)", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ status: "QR", channel: "STARLD-T6W2F", code: 200 }), { status: 200 })
  );
  const result = await client.checkWhapiHealth();
  assert.equal(result.reachable, true);
  assert.equal(result.authorized, false);
  assert.equal(result.statusText, "QR");
});

test("checkWhapiHealth reports authorized:null (not false) for a 200 response in an unrecognized shape, rather than misreporting it as disconnected", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
  const result = await client.checkWhapiHealth();
  assert.equal(result.reachable, true);
  assert.equal(result.authorized, null);
});

test("checkWhapiHealth reports reachable:false with the HTTP status on a non-2xx response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("unauthorized", { status: 401 }));
  const result = await client.checkWhapiHealth();
  assert.equal(result.configured, true);
  assert.equal(result.reachable, false);
  assert.equal(result.authorized, null);
  assert.equal(result.error, "HTTP 401");
});

test("checkWhapiHealth never throws on a network error — reports it in the `error` field instead", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNREFUSED");
  });
  const result = await client.checkWhapiHealth();
  assert.equal(result.reachable, false);
  assert.equal(result.error, "ECONNREFUSED");
});
