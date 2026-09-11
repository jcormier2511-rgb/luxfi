import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
// Deliberately left unset, same posture as whapi/client.health.disabled.test.ts and
// whatsappCloud.unconfigured.test.ts -- confirms the module fails safe (skip-and-log, never a
// live call or a thrown error) rather than guessing at credentials.
delete process.env.GREEN_API_INSTANCE_ID;
delete process.env.GREEN_API_API_TOKEN;

const client = require("./greenApi") as typeof import("./greenApi");

test("sendText skips the live call and warns when unconfigured, without throwing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called while unconfigured");
  });
  await client.sendText("15551234567", "hi");
});

test("sendGroupText skips the live call and warns when unconfigured, without throwing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called while unconfigured");
  });
  await client.sendGroupText("120363043968406745", "hi group");
});

test("sendBannerImage skips the live call and warns when unconfigured, without throwing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called while unconfigured");
  });
  await client.sendBannerImage("15551234567", "https://cdn.example/a.jpg", "caption");
});

test("sendBannerImage with a base64 data: URI also skips (sendFileByUpload path) when unconfigured", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called while unconfigured");
  });
  await client.sendBannerImage("15551234567", "data:image/jpeg;base64,/9j/4AAQ==");
});

test("checkGreenApiHealth reports not configured, without attempting a live call", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called while unconfigured");
  });
  const result = await client.checkGreenApiHealth();
  assert.deepEqual(result, { configured: false, reachable: false, authorized: null, stateInstance: null, error: null });
});
