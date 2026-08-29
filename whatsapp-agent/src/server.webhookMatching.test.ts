import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-webhook-match-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
const PHONE = "15550005712";
process.env.AI_MATCHING_TEST_PHONE = PHONE;

const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");
const client = require("./ai/client") as typeof import("./ai/client");
const rerank = require("./ai/rerank") as typeof import("./ai/rerank");
const whapi = require("./whapi/client") as typeof import("./whapi/client");
const { handleWebhookPayload } = require("./server") as typeof import("./server");

after(async () => {
  await inventoryDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

function webhook(id: string, text: string) {
  return { messages: [{ id, from_me: false, type: "text", chat_id: `${PHONE}@s.whatsapp.net`, from: `${PHONE}@s.whatsapp.net`, text: { body: text } }] };
}

test("live webhook keeps $110,000 intact and qualifies an active $105,000 Patek 5712G", async (t) => {
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([{
    id: "active-5712g", type: "FS", category: "watches", item: "Patek Philippe Nautilus",
    brand: "Patek Philippe", ref: "5712G", condition: "Pre-owned", price: "105000",
    location: "North America", contactName: "Seller", contactPhone: "15551110000", rating: "",
    description: "Patek Philippe Nautilus 5712G active listing at $105,000",
  }], new Date().toISOString());

  t.mock.method(client, "callAiJson", async () => ({
    action: "buy", brand: "Patek", referenceFamily: "5712", maxPrice: 110, minPrice: null,
    location: null, dialColor: null, condition: null, hardRequirements: [], preferences: [],
  }));
  t.mock.method(rerank, "rerankCandidates", async (_query: unknown, candidates: { id: string }[]) =>
    candidates.map(({ id }) => ({ id, explanation: "exact requested reference", evidence: "Patek Philippe 5712G" }))
  );
  const sent: string[] = [];
  t.mock.method(whapi, "sendText", async (_phone: string, message: string) => { sent.push(message); });

  await handleWebhookPayload(webhook("patek-budget-1", "I’m looking for a Patek 5712G under $110,000."));
  await handleWebhookPayload(webhook("patek-budget-2", "any"));

  assert.ok(sent.some((message) => /Potential Match/.test(message) && /active-5712g|105,?000/.test(message)),
    "the active $105,000 listing must qualify through the webhook path");
  assert.ok(!sent.some((message) => /No live matches yet for/.test(message)),
    "the live webhook must not report no matches when the $105,000 listing is active");
});
