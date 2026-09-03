import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test-admin-secret-token-xyz";
process.env.WHAPI_TOKEN = "";
// The tester list. Deliberately mixed-channel: the override must key on the SAME identity
// string the allowlist uses, prefix included, or a Telegram tester silently stays capped.
process.env.RESTRICT_OUTBOUND_TO = "13053897000,telegram:5703391972,sms:13055551234";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createServer } = require("./server") as typeof import("./server");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("./postings/db") as typeof import("./postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("./billing/entitlementStore") as typeof import("./billing/entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getApprovalUsage } = require("./postings/approvalUsage") as typeof import("./postings/approvalUsage");

const TOKEN = "test-admin-secret-token-xyz";
const app = createServer();
let httpServer: Server;
let baseUrl = "";

before(async () => {
  await postingsDb._resetDbForTests();
  await entitlements._resetDbForTests();
  await new Promise<void>((resolve) => { httpServer = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await postingsDb._closePoolForTests();
  await entitlements._closePoolForTests();
});

test("one call lifts the approval cap for every identity on the tester allowlist", async () => {
  const res = await fetch(`${baseUrl}/admin/entitlement/override-testers?token=${TOKEN}`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; enabled: boolean; granted: string[]; failed: unknown[] };
  assert.equal(body.ok, true);
  assert.deepEqual(body.granted, ["13053897000", "telegram:5703391972", "sms:13055551234"]);
  assert.deepEqual(body.failed, []);

  // The gate, not just the stored flag: a tester past the free 3 is still allowed to approve.
  for (const identity of body.granted) {
    const usage = await getApprovalUsage(identity);
    assert.equal(usage.entitlement.manualOverrideEnabled, true, identity);
    assert.equal(usage.weeklyLimit, null, `${identity} must be uncapped, not on a tier's weekly cap`);
  }
});

test("the same call revokes, so testers can be put back on the normal trial", async () => {
  const res = await fetch(`${baseUrl}/admin/entitlement/override-testers?enabled=false&token=${TOKEN}`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal((await getApprovalUsage("telegram:5703391972")).entitlement.manualOverrideEnabled, false);
});

test("the endpoint is admin-token gated like every other entitlement action", async () => {
  for (const query of ["", "?token=", "?token=wrong"]) {
    const res = await fetch(`${baseUrl}/admin/entitlement/override-testers${query}`, { method: "POST" });
    assert.equal(res.status, 401, `"${query}" must not be accepted`);
  }
});
