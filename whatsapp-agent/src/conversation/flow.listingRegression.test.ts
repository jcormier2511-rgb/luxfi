import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs"; import os from "os"; import path from "path";
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"luxfi-slots-")); process.env.PERSIST_DIR=dir; process.env.NODE_ENV="test"; process.env.WEBHOOK_TOKEN="test";
const {handleIncomingMessage}=require("./flow") as typeof import("./flow"); const {resetState}=require("./stateStore") as typeof import("./stateStore");
after(()=>fs.rmSync(dir,{recursive:true,force:true}));

test("WTB fills fields in any order, accepts multiple slots and corrections, then confirms",async()=>{
 const p="15550002001"; resetState(p);
 const first=await handleIncomingMessage(p,"WTB Rolex 116500LN in the US for 28000");
 assert.match(first.messages[0],/Fi/); assert.match(first.messages[1],/black dial, white dial, or either/);
 assert.equal(first.state.pendingBuyIntake?.budget,28000); assert.equal(first.state.pendingBuyIntake?.location,"US");
 const multi=await handleIncomingMessage(p,"white dial, pre-owned");
 assert.match(multi.messages[0],/I have: WTB/); assert.match(multi.messages[0],/white dial.*pre-owned.*US.*\$28,000/);
 const corrected=await handleIncomingMessage(p,"Actually my budget is 30k and I'm in Canada, new, black dial");
 assert.match(corrected.messages[0],/black dial.*new.*Canada.*\$30,000/);
 assert.equal(corrected.state.pendingBuyIntake?.reference,"116500LN");
});

test("any fills only the discussed slot and arbitrary questions do not corrupt the draft",async()=>{
 const p="15550002002"; resetState(p); await handleIncomingMessage(p,"WTB Rolex 116500LN under 25k");
 const any=await handleIncomingMessage(p,"any"); assert.match(any.messages[0],/condition/i); assert.equal(any.state.pendingBuyIntake?.dialColor,"either");
 const question=await handleIncomingMessage(p,"What does pre-owned mean?");
 assert.equal(question.state.pendingBuyIntake?.condition,undefined); assert.equal(question.state.pendingBuyIntake?.location,undefined);
 assert.match(question.messages.at(-1)!,/condition/i);
});

test("a new request during intake asks replace-or-add and replace starts cleanly",async()=>{
 const p="15550002003"; resetState(p); await handleIncomingMessage(p,"FS Rolex 116500LN 28500");
 const conflict=await handleIncomingMessage(p,"WTB Patek 5711 under 80k"); assert.match(conflict.messages[0],/replace.*add another/i);
 const replaced=await handleIncomingMessage(p,"replace"); assert.equal(replaced.state.pendingSellIntake,undefined); assert.equal(replaced.state.pendingBuyIntake?.reference,"5711");
 assert.equal(replaced.state.pendingBuyIntake?.budget,80000);
});

test("FS preserves parsed price/reference and never asks buyer price-range language",async()=>{
 const p="15550002004"; resetState(p); const r=await handleIncomingMessage(p,"FS Rolex 116500LN 28500");
 assert.equal(r.state.pendingSellIntake?.price,28500); assert.equal(r.state.pendingSellIntake?.reference,"116500LN");
 assert.doesNotMatch(r.messages.join("\n"),/price range|searching now|external .*disabled/i);
});

test("WTB confirmation boundary saves the corrected draft exactly once", async (t) => {
  const phone = "15550002005";
  resetState(phone);
  const ingest = require("../postings/ingest") as typeof import("../postings/ingest");
  const saved: import("../postings/postingsStore").DirectSellPostingInput[] = [];
  t.mock.method(ingest, "ingestDirectBuyPosting", async (input: import("../postings/postingsStore").DirectSellPostingInput) => {
    saved.push(input);
    return { matchesFound: 0 };
  });

  const summary = await handleIncomingMessage(phone, "WTB Rolex 116500LN white dial pre-owned in the US for $28,000");
  assert.match(summary.messages.at(-1)!, /Should I start monitoring\?/);
  assert.equal(saved.length, 0, "a complete summarized request must remain a draft");
  assert.ok(summary.state.pendingBuyIntake, "draft remains pending before confirmation");

  const correction = await handleIncomingMessage(phone, "Actually make the budget $30,000 and condition new");
  assert.equal(saved.length, 0, "a correction at confirmation must not activate the request");
  assert.match(correction.messages.at(-1)!, /new.*maximum \$30,000.*Should I start monitoring\?/);
  assert.equal(correction.state.pendingBuyIntake?.budget, 30000);
  assert.equal(correction.state.pendingBuyIntake?.condition, "new");

  const confirmed = await handleIncomingMessage(phone, "yes");
  assert.equal(saved.length, 1, "confirmation activates exactly one request");
  assert.deepEqual(saved[0], {
    phone,
    senderName: undefined,
    description: "Rolex 116500LN white dial pre-owned in the US for $28,000",
    reference: "116500LN",
    price: 30000,
    condition: "new",
    location: "US",
  });
  assert.equal(confirmed.state.pendingBuyIntake, undefined);
  assert.match(confirmed.messages[0], /request is active/i);
});

test("FS confirmation boundary persists and activates every parsed field exactly once", async (t) => {
  const phone = "15550002006";
  resetState(phone);
  const inventory = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
  const ingest = require("../postings/ingest") as typeof import("../postings/ingest");
  const inventoryWrites: Parameters<typeof inventory.upsertListings>[0][] = [];
  const activations: import("../postings/postingsStore").DirectSellPostingInput[] = [];
  t.mock.method(inventory, "upsertListings", async (rows: Parameters<typeof inventory.upsertListings>[0]) => { inventoryWrites.push(rows); });
  t.mock.method(ingest, "ingestDirectSellPosting", async (input: import("../postings/postingsStore").DirectSellPostingInput) => { activations.push(input); return { matchesFound: 0 }; });

  const summary = await handleIncomingMessage(phone, "FS Rolex 116500LN black dial unworn in Canada for 28500");
  assert.match(summary.messages.at(-1)!, /Should I start monitoring\?/);
  assert.equal(inventoryWrites.length, 0, "summary must not persist inventory");
  assert.equal(activations.length, 0, "summary must not activate or match the listing");

  const correction = await handleIncomingMessage(phone, "Actually condition pre-owned and price $29,000");
  assert.equal(inventoryWrites.length, 0);
  assert.equal(activations.length, 0, "correction requires a fresh confirmation");
  assert.match(correction.messages.at(-1)!, /pre-owned.*asking \$29,000.*Should I start monitoring\?/);

  await handleIncomingMessage(phone, "yes");
  assert.equal(inventoryWrites.length, 1, "confirmed seller inventory is persisted once");
  assert.equal(activations.length, 1, "confirmed FS posting is activated/matched once");
  assert.equal(inventoryWrites[0][0].ref, "116500LN");
  assert.equal(inventoryWrites[0][0].price, "29000");
  assert.equal(inventoryWrites[0][0].condition, "pre-owned");
  assert.equal(inventoryWrites[0][0].location, "Canada");
  assert.equal(activations[0].price, 29000);
  assert.equal(activations[0].condition, "pre-owned");
  assert.equal(activations[0].location, "Canada");
});
