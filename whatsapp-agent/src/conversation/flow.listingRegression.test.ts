import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs"; import os from "os"; import path from "path";
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"luxfi-slots-")); process.env.PERSIST_DIR=dir; process.env.NODE_ENV="test"; process.env.WEBHOOK_TOKEN="test";
const {handleIncomingMessage}=require("./flow") as typeof import("./flow"); const {resetState}=require("./stateStore") as typeof import("./stateStore");
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
const persistedRow = (input: import("../postings/postingsStore").DirectSellPostingInput, type: "FS" | "WTB") => ({
  type, brand: input.brand ?? "", model: input.model ?? "", reference: input.reference ?? "", dial: input.dialColor ?? "",
  condition: input.condition ?? "", price: input.price === null ? null : String(input.price), currency: input.currency ?? "USD", location: input.location ?? "",
} as import("../postings/postingsStore").PostingRow);

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
    return { matchesFound: 0, posting: persistedRow(input, "WTB") };
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
    brand: "rolex",
    model: "white",
    reference: "116500LN",
    price: 30000,
    currency: "USD",
    dialColor: "white",
    condition: "new",
    location: "US",
  });
  assert.equal(confirmed.state.pendingBuyIntake, undefined);
  assert.match(confirmed.messages.join("\n"), /Your WTB request is active:[\s\S]*rolex white 116500LN[\s\S]*white dial[\s\S]*Budget: \$30,000[\s\S]*qualifying seller/i);
  assert.doesNotMatch(confirmed.messages.join("\n"), /raw/i, "acknowledgment is rendered from the persisted structured fields");
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
  t.mock.method(ingest, "ingestDirectSellPosting", async (input: import("../postings/postingsStore").DirectSellPostingInput) => { activations.push(input); return { matchesFound: 0, posting: persistedRow(input, "FS") }; });

  const photoPrompt = await handleIncomingMessage(phone, "FS Rolex 116500LN black dial unworn in Canada for 28500");
  assert.match(photoPrompt.messages.at(-1)!, /attach a photo/i);
  const summary = await handleIncomingMessage(phone, "skip");
  assert.match(summary.messages.at(-1)!, /Photo: none.*Should I start monitoring\?/);
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
  assert.equal(activations[0].currency, "USD");
  assert.equal(activations[0].dialColor, "black");
  assert.equal(activations[0].condition, "pre-owned");
  assert.equal(activations[0].location, "Canada");
});

test("an original-message FS photo stays in the draft and appears in the confirmation summary", async (t) => {
  const phone = "15550002007";
  resetState(phone);
  const inventory = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
  const ingest = require("../postings/ingest") as typeof import("../postings/ingest");
  let inventoryWrites = 0;
  let activations = 0;
  t.mock.method(inventory, "upsertListings", async () => { inventoryWrites++; });
  t.mock.method(ingest, "ingestDirectSellPosting", async (input: import("../postings/postingsStore").DirectSellPostingInput) => { activations++; return { matchesFound: 0, posting: persistedRow(input, "FS") }; });

  const summary = await handleIncomingMessage(
    phone,
    "FS Rolex 116500LN white dial pre-owned in USA for EUR 25,000",
    undefined,
    "https://cdn.example/original.jpg"
  );
  assert.match(summary.messages.at(-1)!, /Photo: attached.*Should I start monitoring\?/);
  assert.equal(summary.state.pendingSellIntake?.imageUrl, "https://cdn.example/original.jpg");
  assert.equal(summary.state.pendingSellIntake?.currency, "EUR");
  assert.equal(inventoryWrites, 0);
  assert.equal(activations, 0);

  await handleIncomingMessage(phone, "yes");
  assert.equal(inventoryWrites, 1);
  assert.equal(activations, 1);
});

test("reference and price remain independent through price and reference corrections", async () => {
  const phone = "15550002008"; resetState(phone);
  await handleIncomingMessage(phone, "FS Rolex Daytona 126500LN white dial for 38000, pre-owned in USA", undefined, "https://example.test/watch.jpg");
  const priceEdit = await handleIncomingMessage(phone, "change price to 36500");
  assert.equal(priceEdit.state.pendingSellIntake?.reference, "126500LN");
  assert.equal(priceEdit.state.pendingSellIntake?.price, 36500);
  assert.match(priceEdit.messages.at(-1)!, /Reference: 126500LN[\s\S]*Price: \$36,500/);
  const referenceEdit = await handleIncomingMessage(phone, "change reference to 126500LN");
  assert.equal(referenceEdit.state.pendingSellIntake?.reference, "126500LN");
  assert.equal(referenceEdit.state.pendingSellIntake?.price, 36500);
});

test("a bare price answer updates only price and a price-shaped reference answer is rejected", async () => {
  const phone = "15550002009"; resetState(phone);
  const pricePrompt = await handleIncomingMessage(phone, "FS Rolex Daytona 126500LN");
  assert.match(pricePrompt.messages.at(-1)!, /asking price/i);
  const priced = await handleIncomingMessage(phone, "38000");
  assert.equal(priced.state.pendingSellIntake?.reference, "126500LN");
  assert.equal(priced.state.pendingSellIntake?.price, 38000);

  const ambiguousPhone = "15550002010"; resetState(ambiguousPhone);
  await handleIncomingMessage(ambiguousPhone, "FS Rolex Daytona");
  const ambiguous = await handleIncomingMessage(ambiguousPhone, "38000");
  assert.equal(ambiguous.state.pendingSellIntake?.reference, null);
  assert.match(ambiguous.messages.join("\n"), /looks like a price, not a reference/i);

  const qualifiedPhone = "15550002012"; resetState(qualifiedPhone);
  await handleIncomingMessage(qualifiedPhone, "FS Rolex Daytona");
  const qualified = await handleIncomingMessage(qualifiedPhone, "USD 38000");
  assert.equal(qualified.state.pendingSellIntake?.reference, null, "a currency-qualified price must not become identity");
  assert.match(qualified.messages.join("\n"), /looks like a price, not a reference/i);
});

test("a common six-digit numeric manufacturer reference remains valid", async () => {
  const phone = "15550002013"; resetState(phone);
  await handleIncomingMessage(phone, "FS Rolex Daytona");
  const referenced = await handleIncomingMessage(phone, "116500");
  assert.equal(referenced.state.pendingSellIntake?.reference, "116500");
  assert.match(referenced.messages.at(-1)!, /asking price/i);
});

test("confirmation-time brand and model corrections preserve price and reference", async () => {
  const phone = "15550002014"; resetState(phone);
  await handleIncomingMessage(phone, "FS Rolex Daytona 126500LN white dial for 38000, pre-owned in USA", undefined, "https://example.test/watch.jpg");
  const brand = await handleIncomingMessage(phone, "change brand to Omega");
  assert.equal(brand.state.pendingSellIntake?.brand, "omega");
  assert.equal(brand.state.pendingSellIntake?.reference, "126500LN");
  assert.equal(brand.state.pendingSellIntake?.price, 38000);
  const model = await handleIncomingMessage(phone, "change model to Speedmaster");
  assert.equal(model.state.pendingSellIntake?.model, "Speedmaster");
  assert.equal(model.state.pendingSellIntake?.reference, "126500LN");
  assert.equal(model.state.pendingSellIntake?.price, 38000);
});

test("first contact intro is shared by Telegram and WhatsApp identities and sent once", async () => {
  for (const identity of ["telegram:99101", "whatsapp:15559910101"]) {
    resetState(identity);
    const first = await handleIncomingMessage(identity, "hi");
    assert.match(first.messages[0], /Fi/i);
    const second = await handleIncomingMessage(identity, "hi");
    assert.equal(second.messages.filter((message) => message === first.messages[0]).length, 0);
  }
});

test("current WatchFacts command uses active opposite-side inventory, deduplicates, and caps at five", async (t) => {
  const phone = "15550002011"; resetState(phone);
  await handleIncomingMessage(phone, "WTB Rolex Daytona 126500LN for 40000");
  const inventory = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
  const rows = Array.from({ length: 7 }, (_, index) => ({
    id: `wf-${index}`, type: "FS" as const, category: "watches", item: "Daytona", brand: "Rolex", ref: "126500LN",
    condition: "New", price: String(28000 + index), location: "Miami", contactName: "Dealer", contactPhone: String(index),
    source: "WF", rating: "", description: `Rolex Daytona 126500LN ${index}`, detailUrl: `https://watchfacts.example/${index}`,
  }));
  rows.splice(1, 0, { ...rows[0], id: "duplicate" });
  t.mock.method(inventory, "getActiveListings", async (type?: "FS" | "WTB") => rows.filter((row) => !type || row.type === type));
  const result = await handleIncomingMessage(phone, "show current listings");
  assert.match(result.messages.at(-1)!, /5 current WatchFacts listings/);
  assert.match(result.messages.at(-1)!, /126500LN/);
  assert.doesNotMatch(result.messages.at(-1)!, /6\. /);
});

test("current inventory compares formatted references canonically", async (t) => {
  const phone = "15550002015"; resetState(phone);
  const inventory = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
  t.mock.method(inventory, "getActiveListings", async () => [{
    id: "formatted", type: "FS", category: "watches", item: "Cosmograph", brand: "Rolex", ref: "1165080013",
    condition: "New", price: "50000", location: "NY", contactName: "Dealer", contactPhone: "2", source: "WF",
    rating: "", description: "Rolex 1165080013",
  }]);
  const result = await handleIncomingMessage(phone, "current listings for 116508-0013");
  assert.match(result.messages.at(-1)!, /1165080013/);
  assert.doesNotMatch(result.messages.at(-1)!, /don’t see any/i);
});
