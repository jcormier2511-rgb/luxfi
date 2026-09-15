import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.WHAPI_TOKEN = "test-whapi-token";
process.env.GREEN_API_INSTANCE_ID = "1234567890";
process.env.GREEN_API_API_TOKEN = "test-green-api-token";
process.env.WHATSAPP_CLOUD_ACCESS_TOKEN = "test-cloud-token";
process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = "1234567890";
// The setting under test -- must be set before config.ts is first required.
process.env.WHATSAPP_1TO1_PROVIDER = "cloud";

const channels = require("./index") as typeof import("./index");

/**
 * config.channels.whatsapp1to1Provider (see config.ts's own comment) is a temporary runtime
 * switch between Green API and the official Cloud API for 1:1 dispatch, added while Meta's
 * Business Platform registration for Fi's number was stuck. channels/index.test.ts covers the
 * default ("greenApi") branch; this file, in its own process (so the env var above is read
 * before config.ts's module-level object is ever built), covers explicitly setting it to "cloud".
 */
test('required: WHATSAPP_1TO1_PROVIDER=cloud routes a plain (unprefixed) identity to the official Cloud API instead of Green API', async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({}), { status: 200 });
  });
  await channels.sendText("15551234567", "hi");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /graph\.facebook\.com/);
});

test('required: WHATSAPP_1TO1_PROVIDER=cloud also routes sendBannerImage to the Cloud API', async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({}), { status: 200 });
  });
  await channels.sendBannerImage("15551234567", "https://cdn.example/a.jpg", "caption");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /graph\.facebook\.com/);
});
