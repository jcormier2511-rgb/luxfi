import { test, after, TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Real reported gap: "I want to sell a watch" ran a doomed search against the (disabled) WTB
// feed and just reported "no matches" — the seller's message was never used for anything. A
// "sell" search that finds nothing now collects what Fi actually needs to describe the item to
// a future buyer: more detail if the request was vague, a price, and a photo, then creates a
// real 'direct'-sourced FS posting and matches it against live WTB postings immediately (see
// postings/ingest.ts's ingestDirectSellPosting) — so this file also touches the postings DB.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-sellintake-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
// Only needed for the one test below that seeds a chat-sourced WTB counterpart to prove the
// direct-posting match/notify path end to end — the 'direct' FS side's own matching and
// decision-handling need no flag at all (see server.directPostingDecision.test.ts, which
// proves that half with this left unset). Must be set before config.ts is first required.
process.env.ENABLE_V4_POSTINGS = "true";
process.env.V4_ALLOWED_CHAT_IDS = "*";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState } = require("./stateStore") as typeof import("./stateStore");

after(async () => {
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

function mockSends(t: TestContext): { phone: string; message: string }[] {
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => {
    sent.push({ phone, message });
  });
  return sent;
}

/** Walks a fresh contact through the once-per-contact preference interview with "any" each
 *  time (same pattern as flow.matching.test.ts), then returns the search's own result. */
async function freshRequest(phone: string, query: string) {
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, query);
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  return handleIncomingMessage(phone, "any");
}

test('required: "I want to sell a watch" asks for identifying details without searching or saving first', async () => {
  const phone = "19992220001"; resetState(phone); await inventoryDb._resetDbForTests();
  await handleIncomingMessage(phone, "hi");
  const result = await handleIncomingMessage(phone, "I want to sell a watch");
  assert.match(result.messages.join("\n"), /Tell me a bit more about what you're selling/i);
  assert.doesNotMatch(result.messages.join("\n"), /No live matches|searching/i);
  assert.equal(result.state.pendingSellIntake?.step, "details");
});

test("required: a specific request skips straight to the price question", async () => {
  const phone = "19992220002"; resetState(phone); await inventoryDb._resetDbForTests();
  await handleIncomingMessage(phone, "hi");
  const result = await handleIncomingMessage(phone, "I want to sell a 116500 white dial");
  assert.doesNotMatch(result.messages.join("\n"), /Tell me a bit more/i);
  assert.match(result.messages.join("\n"), /What's your asking price\?/);
});

test("required: seller details are collected, summarized, and only saved after confirmation", async (t) => {
  const phone = "19992220003"; resetState(phone); await inventoryDb._resetDbForTests(); await postingsDb._resetDbForTests(); mockSends(t);
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "I want to sell a watch");
  await handleIncomingMessage(phone, "It's a Rolex Submariner 116610LV");
  await handleIncomingMessage(phone, "$14,500");
  await handleIncomingMessage(phone, "pre-owned");
  const summary = await handleIncomingMessage(phone, "USA");
  assert.match(summary.messages.join("\n"), /Should I start monitoring\?/);
  assert.ok(summary.state.pendingSellIntake, "summary is still an unsaved draft");
  const confirmed = await handleIncomingMessage(phone, "yes");
  assert.match(confirmed.messages.join("\n"), /listing is active/i);
  assert.equal(confirmed.state.pendingSellIntake, undefined);
});

test("photo remains optional and can be attached before confirmation", async (t) => {
  const phone = "19992220004"; resetState(phone); await inventoryDb._resetDbForTests(); await postingsDb._resetDbForTests(); mockSends(t);
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "FS Patek 5711/1A $85,000 pre-owned in USA");
  const withPhoto = await handleIncomingMessage(phone, "here it is", undefined, "https://cdn.example/patek.jpg");
  assert.match(withPhoto.messages.at(-1)!, /Should I start monitoring\?/);
  assert.equal(withPhoto.state.pendingSellIntake?.imageUrl, "https://cdn.example/patek.jpg");
});

test("required: confirmation creates a direct FS posting and immediately matches live WTB demand", async (t) => {
  const phone = "19992220007"; resetState(phone); await inventoryDb._resetDbForTests(); await postingsDb._resetDbForTests(); const sent = mockSends(t);
  const { ingestAndMatch } = require("../postings/ingest") as typeof import("../postings/ingest");
  await ingestAndMatch({ platform:"whatsapp", chatId:"group-1", messageId:"wtb-direct-1", senderIdentity:"19991110000", text:"WTB Rolex Submariner 116610LV budget $16,000" });
  sent.length=0;
  await handleIncomingMessage(phone, "hi");
  const summary = await handleIncomingMessage(phone, "FS Rolex Submariner 116610LV pre-owned in USA for $14,500");
  assert.match(summary.messages.at(-1)!, /Should I start monitoring\?/);
  assert.equal(sent.length, 0, "no match notification before confirmation");
  const confirmed = await handleIncomingMessage(phone, "yes");
  assert.match(confirmed.messages.join("\n"), /listing is active.*found 1 potential buyer/i);
  assert.ok(sent.some((m)=>m.phone==="19991110000" && /Potential Match/.test(m.message)));
});

test('"cancel" mid-intake clears it without unsubscribing', async () => {
  const phone="19992220005"; resetState(phone); await inventoryDb._resetDbForTests(); await handleIncomingMessage(phone,"hi");
  const start=await handleIncomingMessage(phone,"I want to sell a watch"); assert.ok(start.state.pendingSellIntake);
  const result=await handleIncomingMessage(phone,"cancel"); assert.equal(result.state.pendingSellIntake,undefined); assert.notEqual(result.state.stage,"opted_out");
});

test("a buy search with real matches is completely unaffected by the sell-intake change", async () => {
  const phone = "19992220006";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [
      {
        id: "buy-unaffected-1",
        type: "FS",
        category: "watches",
        item: "Rolex Daytona 116500LN",
        brand: "Rolex",
        ref: "116500LN",
        condition: "",
        price: "28000",
        location: "",
        contactName: "seller-1",
        contactPhone: "10000000000",
        rating: "",
        description: "Rolex Daytona 116500LN",
      },
    ],
    new Date().toISOString()
  );

  const result = await freshRequest(phone, "buy: Rolex Daytona 116500LN");
  assert.ok(result.messages.some((m) => /Potential Match/.test(m)));
  assert.equal(result.state.pendingSellIntake, undefined);
});
