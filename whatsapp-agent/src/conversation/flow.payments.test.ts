import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-payments-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
// Just enough to make isAuthorizeNetConfigured() true — no live call happens in these tests
// (createCheckoutSession never calls Authorize.net itself; that only happens once the link is
// actually clicked, see GET /pay/:id in server.ts).
process.env.AUTHORIZENET_API_LOGIN_ID = "test-login-id";
process.env.AUTHORIZENET_TRANSACTION_KEY = "test-transaction-key";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("../billing/entitlementStore") as typeof import("../billing/entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");

after(async () => {
  await entitlements._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

test("\"join\" with Authorize.net configured sends a real checkout link instead of just recording intent", async () => {
  await entitlements._resetDbForTests();
  const phone = "19990001001";

  const result = await handleIncomingMessage(phone, "join");
  const message = result.messages.join("\n");
  assert.match(message, /\/pay\//, "should send a payment link, not the old admin-review message");
  assert.doesNotMatch(message, /Our team will review/);

  const entitlement = await entitlements.getEntitlement(phone);
  assert.equal(entitlement.plan, null, "the plan isn't granted until the webhook confirms payment");
  assert.equal(entitlement.paymentStatus, null, "join itself must never call recordBillingRequested's admin-review path once real payments are configured");
});

test("\"upgrade\" with no tier lists the available tiers instead of assuming one", async () => {
  await entitlements._resetDbForTests();
  const phone = "19990001002";

  const result = await handleIncomingMessage(phone, "upgrade");
  const message = result.messages.join("\n");
  assert.match(message, /upgrade tier1/);
  assert.match(message, /upgrade tier2/);
  assert.match(message, /upgrade tier3/);
});

/** It offered every OTHER tier, so a tier2 member asking to upgrade was offered tier1 — a
 *  downgrade, labelled an upgrade — despite the code's own comment saying "roomier". */
test("\"upgrade\" offers only roomier tiers, never a downgrade", async () => {
  await entitlements._resetDbForTests();
  const phone = "19990001009";
  await entitlements.setPlan(phone, "tier2"); // 20/week

  const message = (await handleIncomingMessage(phone, "upgrade")).messages.join("\n");
  assert.match(message, /upgrade tier3/, "unlimited is roomier than 20/week");
  assert.doesNotMatch(message, /upgrade tier1/, "5/week is a downgrade from 20/week");
  assert.doesNotMatch(message, /upgrade tier2/, "already on it");
});

test("a member on the top tier is told so rather than offered anything", async () => {
  await entitlements._resetDbForTests();
  const phone = "19990001010";
  await entitlements.setPlan(phone, "tier3"); // unlimited

  const message = (await handleIncomingMessage(phone, "upgrade")).messages.join("\n");
  assert.match(message, /already on our top tier/i);
});

test("\"upgrade tier3\" sends a checkout link for that specific tier", async () => {
  await entitlements._resetDbForTests();
  const phone = "19990001003";

  const result = await handleIncomingMessage(phone, "upgrade tier3");
  const message = result.messages.join("\n");
  assert.match(message, /\/pay\//);
  assert.match(message, /Tier 3/);
  assert.match(message, /\$300/);
});
