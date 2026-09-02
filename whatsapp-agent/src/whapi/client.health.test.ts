import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.WHAPI_TOKEN = "super-secret-whapi-token";

const client = require("./client") as typeof import("./client");

test("checkWhapiHealth reports authorized:true for a live AUTH channel and never leaks the token into the result", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://gate.whapi.cloud/health");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer super-secret-whapi-token");
    return new Response(JSON.stringify({ health: { status: { code: 3, text: "AUTH" }, version: "1.8.3" } }), { status: 200 });
  });
  const result = await client.checkWhapiHealth();
  assert.equal(result.configured, true);
  assert.equal(result.reachable, true);
  assert.equal(result.authorized, true);
  assert.equal(result.statusText, "AUTH");
  assert.equal(result.version, "1.8.3");
  assert.equal(result.error, null);
  assert.equal(JSON.stringify(result).includes("super-secret-whapi-token"), false, "the token itself must never appear in the reported result");
});

test("checkWhapiHealth reports authorized:false for a non-AUTH status (e.g. waiting on a QR scan)", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ health: { status: { code: 1, text: "QR" }, version: "1.8.3" } }), { status: 200 })
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
