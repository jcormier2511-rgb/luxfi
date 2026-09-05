import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "reset-admin-token";
process.env.WHAPI_TOKEN = "";

const { createServer } = require("./server") as typeof import("./server");
const postingsDb = require("./postings/db") as typeof import("./postings/db");
const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");
const { createDirectPosting, getActivePostingsForUser, getPosting } = require("./postings/postingsStore") as typeof import("./postings/postingsStore");
const { getOrCreateCanonicalUser } = require("./postings/identity") as typeof import("./postings/identity");
const { linkIdentity, setPreferredChannel, getNotificationPreference } = require("./postings/notificationPreferences") as typeof import("./postings/notificationPreferences");
const { platformForIdentity } = require("./channels/identity") as typeof import("./channels/identity");
const { getState, saveState } = require("./conversation/stateStore") as typeof import("./conversation/stateStore");

const TOKEN = "reset-admin-token";
let httpServer: Server;
let baseUrl = "";

before(async () => {
  await postingsDb._resetDbForTests();
  const app = createServer();
  await new Promise<void>((resolve) => { httpServer = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await postingsDb._closePoolForTests();
  await inventoryDb._closePoolForTests();
});

test("resetting one identity of an already-linked WhatsApp/Telegram pair clears postings, conversation state, and notification preference for BOTH channels, and touches nobody else's", async () => {
  const whatsapp = "15550003001";
  const telegram = "telegram:5703393001";
  const other = "15550009998";

  const userId = await getOrCreateCanonicalUser(platformForIdentity(whatsapp), whatsapp);
  const link = await linkIdentity(userId, "telegram", telegram);
  assert.equal(link.ok, true);
  await setPreferredChannel(userId, "telegram");

  const a = await createDirectPosting({ phone: whatsapp, type: "WTB", description: "WTB rolex test draft", brand: "rolex", reference: null, price: 25000 });
  const b = await createDirectPosting({ phone: telegram, type: "FS", description: "FS rolex 116500LN test draft", brand: "rolex", reference: "116500LN", price: 30000 });
  const keep = await createDirectPosting({ phone: other, type: "FS", description: "FS Rolex 126500LN", brand: "rolex", reference: "126500LN", price: 32000 });

  const wState = getState(whatsapp); wState.stage = "active"; wState.hired = true; wState.preferencesCollected = true; saveState(wState);
  const tState = getState(telegram); tState.stage = "active"; tState.hired = true; saveState(tState);

  const res = await fetch(`${baseUrl}/admin/user/reset?phone=${encodeURIComponent(whatsapp)}&token=${TOKEN}`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; canonicalUserId: number; identitiesReset: string[]; closedPostings: { id: number }[] };
  assert.equal(body.ok, true);
  assert.equal(body.canonicalUserId, userId);
  assert.deepEqual(body.identitiesReset.sort(), [whatsapp, telegram].sort(), "resets every identity linked to the canonical user, not just the one named");
  assert.deepEqual(body.closedPostings.map((c) => c.id).sort(), [a.id, b.id].sort());

  assert.deepEqual(await getActivePostingsForUser(userId), [], "no active postings remain on either channel");
  assert.equal((await getPosting(a.id))?.status, "admin_closed");
  assert.equal((await getPosting(b.id))?.status, "admin_closed");

  assert.equal(getState(whatsapp).stage, "new", "conversation state for the named identity looks brand new");
  assert.equal(getState(whatsapp).hired, false);
  assert.equal(getState(telegram).stage, "new", "conversation state for the OTHER linked identity is reset too");

  assert.deepEqual(await getNotificationPreference(userId), { preferredChannel: null, fallbackEnabled: false, wtbAlertsPaused: false }, "notification preference reverts to having never been set");

  const otherId = await getOrCreateCanonicalUser(platformForIdentity(other), other);
  assert.equal((await getActivePostingsForUser(otherId)).length, 1, "another account's listing is untouched");
  assert.equal((await getPosting(keep.id))?.status, "active");
});

test("resetting an identity with no link partner only resets itself", async () => {
  const solo = "15550003002";
  await createDirectPosting({ phone: solo, type: "WTB", description: "WTB rolex solo draft", brand: "rolex", reference: null, price: 20000 });
  const soloState = getState(solo); soloState.stage = "active"; saveState(soloState);

  const res = await fetch(`${baseUrl}/admin/user/reset?phone=${encodeURIComponent(solo)}&token=${TOKEN}`, { method: "POST" });
  const body = (await res.json()) as { identitiesReset: string[] };
  assert.deepEqual(body.identitiesReset, [solo]);
  assert.equal(getState(solo).stage, "new");
});

test("the reset is admin-token gated and refuses to run without an identity", async () => {
  assert.equal((await fetch(`${baseUrl}/admin/user/reset?phone=telegram:1&token=wrong`, { method: "POST" })).status, 401);
  const noPhone = await fetch(`${baseUrl}/admin/user/reset?token=${TOKEN}`, { method: "POST" });
  assert.equal(noPhone.status, 400, "there is deliberately no reset-everyone");
});
