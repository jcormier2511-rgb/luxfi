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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getActivePostingsForUser } = require("../postings/postingsStore") as typeof import("../postings/postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getOrCreateCanonicalUser } = require("../postings/identity") as typeof import("../postings/identity");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { platformForIdentity } = require("../channels/identity") as typeof import("../channels/identity");

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
  const phone = "19992220002"; resetState(phone); await inventoryDb._resetDbForTests(); await postingsDb._resetDbForTests();
  await handleIncomingMessage(phone, "hi");
  const result = await handleIncomingMessage(phone, "I want to sell a 116500 white dial");
  assert.doesNotMatch(result.messages.join("\n"), /Tell me a bit more/i);
  assert.match(result.messages.join("\n"), /What would you like to ask\?/);
});

test("required regression: a seller who names a reference but no asking price still sees the Market Guide before Fi asks what to charge, and never has a price chosen for them", async (t) => {
  const phone = "19992220012"; resetState(phone); await inventoryDb._resetDbForTests(); await postingsDb._resetDbForTests(); mockSends(t);
  const prices = [23800, 24700, 25900];
  for (const [i, price] of prices.entries()) {
    await postingsDb.withSchema((pool) =>
      pool.query(
        `INSERT INTO postings (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,price,currency,contact_phone,status,expires_at)
         VALUES ('whatsapp','chat','other-group',$1,NULL,'FS','fixture','116500LN',$2,'USD',$3,'active',now()+interval '1 day')`,
        [`nopricemg-fixture-${i}`, price, `nopricemg-seller-${i}`]
      )
    );
  }

  await handleIncomingMessage(phone, "hi");
  const result = await handleIncomingMessage(phone, "Sell my Rolex Daytona 116500LN black dial, pre-owned, full set, Miami");
  const text = result.messages.join("\n");
  assert.match(text, /MARKET GUIDE/);
  assert.match(text, /Current sellers: 3/);
  assert.match(text, /Dealer asking range: \$/);
  assert.match(text, /Median dealer ask: \$/);
  assert.doesNotMatch(text, /Your ask:/, "spec: must not show/assume a seller ask that was never given");
  assert.doesNotMatch(text, /Market position:/, "spec: no market position without a seller ask to classify");
  assert.match(text, /What would you like to ask\?/);
  assert.equal(result.state.pendingSellIntake?.price, undefined, "spec: must not automatically choose the seller's price");
});

test('required regression: a price/condition mentioned mid-sentence ("... or 38000 preowned") must not fuse the words around it into a garbled model like "orpreowned"', async () => {
  const phone = "19992220003"; resetState(phone); await inventoryDb._resetDbForTests();
  await handleIncomingMessage(phone, "hi");
  const result = await handleIncomingMessage(phone, "I want to sell a rolex 116500 black dial or 38000 preowned");
  const text = result.messages.join("\n");
  assert.doesNotMatch(text, /orpreowned/i, "the price-stripping regex must not fuse the words on either side of a mid-sentence number when removing it");
  assert.equal(result.state.pendingSellIntake?.condition, "pre-owned", "the condition itself must still be recognized correctly");
});

test("required regression: a fresh, complete sell message is recognized as NEW rather than silently merged into an abandoned draft stuck at the photo step", async () => {
  const phone = "19992220004"; resetState(phone); await inventoryDb._resetDbForTests();
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "I want to sell a Rolex 116500");
  await handleIncomingMessage(phone, "39000");
  await handleIncomingMessage(phone, "pre-owned");
  const afterLocation = await handleIncomingMessage(phone, "Miami");
  assert.equal(afterLocation.state.pendingSellIntake?.step, "photo", "sanity check: the draft is stuck exactly where the real reported bug got stuck");

  const result = await handleIncomingMessage(phone, "I want to sell a rolex 116500 black dial or 38000 preowned");
  const text = result.messages.join("\n");
  assert.match(text, /already have an incomplete request/i, "a fresh, complete sell message must be recognized as new, not silently merged into the stale draft as a scoped edit");
  assert.doesNotMatch(text, /orpreowned/i);
});

test("required: seller details are collected, summarized, and only saved after confirmation", async (t) => {
  const phone = "19992220003"; resetState(phone); await inventoryDb._resetDbForTests(); await postingsDb._resetDbForTests(); mockSends(t);
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "I want to sell a watch");
  await handleIncomingMessage(phone, "It's a Rolex Submariner 116610LV");
  await handleIncomingMessage(phone, "$14,500");
  await handleIncomingMessage(phone, "pre-owned");
  const photoPrompt = await handleIncomingMessage(phone, "USA");
  assert.match(photoPrompt.messages.join("\n"), /attach a photo/i);
  const summary = await handleIncomingMessage(phone, "skip");
  assert.match(summary.messages.join("\n"), /Photo: none[\s\S]*Should I start monitoring\?/);
  assert.ok(summary.state.pendingSellIntake, "summary is still an unsaved draft");
  const confirmed = await handleIncomingMessage(phone, "yes");
  assert.match(confirmed.messages.join("\n"), /Your FS listing is active:[\s\S]*Rolex Submariner 116610LV[\s\S]*Asking: \$14,500[\s\S]*USA[\s\S]*qualifying buyer/i);
  assert.match(confirmed.messages[0], /What happens next:\n• I’ll message you here the moment a matching buyer appears[\s\S]*review this listing, or "cancel" to stop monitoring\.\n• Reply "help"/, "sellers get the same next-steps block, worded for a listing");
  assert.equal(confirmed.state.pendingSellIntake, undefined);
});

test("photo remains optional and can be attached before confirmation", async (t) => {
  const phone = "19992220004"; resetState(phone); await inventoryDb._resetDbForTests(); await postingsDb._resetDbForTests(); mockSends(t);
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "FS Patek 5711/1A $85,000 pre-owned in USA");
  const withPhoto = await handleIncomingMessage(phone, "here it is", undefined, "https://cdn.example/patek.jpg");
  assert.match(withPhoto.messages.at(-1)!, /Photo: attached[\s\S]*Should I start monitoring\?/);
  assert.equal(withPhoto.state.pendingSellIntake?.imageUrl, "https://cdn.example/patek.jpg");
});

test("required regression: once a photo is attached, the review reads as that photo's caption instead of a separate text message", async (t) => {
  const phone = "19992220024"; resetState(phone); await inventoryDb._resetDbForTests(); await postingsDb._resetDbForTests(); mockSends(t);
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "FS Patek 5711/1A $85,000 pre-owned in USA");
  const withPhoto = await handleIncomingMessage(phone, "here it is", undefined, "https://cdn.example/patek.jpg");
  assert.deepEqual(withPhoto.photoReply, { imageUrl: "https://cdn.example/patek.jpg", caption: withPhoto.messages.at(-1) });

  // Once confirmed, the acknowledgment is a fresh plain-text message, not the photo's caption again.
  const confirmed = await handleIncomingMessage(phone, "confirm");
  assert.equal(confirmed.photoReply, undefined, "the post-confirmation acknowledgment is not re-attached to the photo");
});

test("required regression: no photo attached means no photoReply at all — the review stays plain text", async (t) => {
  const phone = "19992220025"; resetState(phone); await inventoryDb._resetDbForTests(); await postingsDb._resetDbForTests(); mockSends(t);
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "FS Patek 5711/1A $85,000 pre-owned in USA");
  const noPhoto = await handleIncomingMessage(phone, "no photo");
  assert.match(noPhoto.messages.at(-1)!, /Photo: none/);
  assert.equal(noPhoto.photoReply, undefined);
});

test("required: confirmation creates a direct FS posting and immediately matches live WTB demand", async (t) => {
  const phone = "19992220007"; resetState(phone); await inventoryDb._resetDbForTests(); await postingsDb._resetDbForTests(); const sent = mockSends(t);
  const { ingestAndMatch } = require("../postings/ingest") as typeof import("../postings/ingest");
  await ingestAndMatch({ platform:"whatsapp", chatId:"group-1", messageId:"wtb-direct-1", senderIdentity:"19991110000", text:"WTB Rolex Submariner 116610LV budget $16,000" });
  sent.length=0;
  await handleIncomingMessage(phone, "hi");
  const photoPrompt = await handleIncomingMessage(phone, "FS Rolex Submariner 116610LV pre-owned in USA for $14,500");
  assert.match(photoPrompt.messages.at(-1)!, /attach a photo/i);
  const summary = await handleIncomingMessage(phone, "no photo");
  assert.match(summary.messages.at(-1)!, /Photo: none[\s\S]*Should I start monitoring\?/);
  assert.equal(sent.length, 0, "no match notification before confirmation");
  const confirmed = await handleIncomingMessage(phone, "yes");
  assert.match(confirmed.messages.join("\n"), /listing is active[\s\S]*found 1 potential buyer/i);
  assert.ok(sent.some((m)=>m.phone==="19991110000" && /Potential Match/.test(m.message)));
});

test("required regression: FS confirmation also shows current matching WTB listings on WatchFacts, same as buy confirmation already does for FS listings", async (t) => {
  const phone = "19992220008"; resetState(phone); await inventoryDb._resetDbForTests(); await postingsDb._resetDbForTests(); mockSends(t);
  t.mock.method(inventoryDb, "getActiveListings", async (type?: "FS" | "WTB") =>
    type === "WTB"
      ? [{
          id: "wtb-wf-1", type: "WTB" as const, category: "watches", item: "Daytona", brand: "Rolex", ref: "116500LN",
          condition: "Any", price: "30000", location: "USA", contactName: "Buyer Co", contactPhone: "1",
          source: "WF", rating: "", description: "Rolex Daytona 116500LN wanted",
        }]
      : []
  );
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "FS Rolex Daytona 116500LN pre-owned in USA for $25,000");
  await handleIncomingMessage(phone, "any"); // dial
  await handleIncomingMessage(phone, "no photo");
  const result = await handleIncomingMessage(phone, "confirm");
  const text = result.messages.join("\n");
  assert.match(text, /current WatchFacts listing/i, "a seller must also see what's already on WatchFacts for their exact item, same as a buyer does");
  assert.match(text, /Rolex.*116500LN|Daytona/i);
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

test("required regression: Market Guide appears at the review step (not activation), using real current dealer data, and the listing stays a draft until the seller confirms", async (t) => {
  const phone = "19992220010"; resetState(phone); await inventoryDb._resetDbForTests(); await postingsDb._resetDbForTests(); mockSends(t);
  // Seed 5 comparable FS asks so the guide has a real range to show, plus one WTB request.
  const prices = [23800, 24200, 24700, 25200, 25900];
  for (const [i, price] of prices.entries()) {
    await postingsDb.withSchema((pool) =>
      pool.query(
        `INSERT INTO postings (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,price,currency,contact_phone,status,expires_at)
         VALUES ('whatsapp','chat','other-group',$1,NULL,'FS','fixture','116500LN',$2,'USD',$3,'active',now()+interval '1 day')`,
        [`mg-fixture-${i}`, price, `mg-seller-${i}`]
      )
    );
  }
  await postingsDb.withSchema((pool) =>
    pool.query(
      `INSERT INTO postings (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,status,expires_at)
       VALUES ('whatsapp','chat','other-group','mg-wtb-1',NULL,'WTB','fixture','116500LN','active',now()+interval '1 day')`
    )
  );

  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "Sell my 2022 Rolex Daytona 116500LN black dial, pre-owned, full set for $24,500, Miami");
  const review = await handleIncomingMessage(phone, "skip");
  const reviewText = review.messages.join("\n");
  assert.match(reviewText, /MARKET GUIDE/);
  assert.match(reviewText, /Current sellers: 5/);
  assert.match(reviewText, /Current buyers: 1/);
  assert.match(reviewText, /Dealer asking range: \$/);
  assert.match(reviewText, /Median dealer ask: \$/);
  assert.match(reviewText, /Your ask: \$24,500/);
  assert.match(reviewText, /Market position: /);
  assert.doesNotMatch(reviewText, /valuation/i, "spec: never call this a valuation");

  // Spec: generating the guide must never activate the listing.
  const userId = await getOrCreateCanonicalUser(platformForIdentity(phone), phone);
  assert.deepEqual(await getActivePostingsForUser(userId), [], "no active listing before confirmation");

  const confirmed = await handleIncomingMessage(phone, "confirm");
  assert.match(confirmed.messages.join("\n"), /listing is active/i);
  assert.equal((await getActivePostingsForUser(userId)).length, 1, "confirmation is what actually activates the draft");
});

test("required regression: Telegram and WhatsApp show equivalent Market Guide information for the same seller message", async () => {
  const whatsapp = "19992220011";
  const telegram = "telegram:19992220011";
  resetState(whatsapp);
  resetState(telegram);
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();

  const prices = [23800, 24700, 25900];
  for (const [i, price] of prices.entries()) {
    await postingsDb.withSchema((pool) =>
      pool.query(
        `INSERT INTO postings (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,price,currency,contact_phone,status,expires_at)
         VALUES ('whatsapp','chat','other-group',$1,NULL,'FS','fixture','116500LN',$2,'USD',$3,'active',now()+interval '1 day')`,
        [`equiv-fixture-${i}`, price, `equiv-seller-${i}`]
      )
    );
  }

  const text = "Sell my 2022 Rolex Daytona 116500LN black dial, pre-owned, full set for $24,500, Miami";
  await handleIncomingMessage(whatsapp, "hi");
  await handleIncomingMessage(telegram, "hi");
  await handleIncomingMessage(whatsapp, text);
  await handleIncomingMessage(telegram, text);
  const viaWhatsApp = (await handleIncomingMessage(whatsapp, "skip")).messages.join("\n");
  const viaTelegram = (await handleIncomingMessage(telegram, "skip")).messages.join("\n");

  const marketGuideBlock = (s: string) => s.slice(s.indexOf("MARKET GUIDE"));
  assert.notEqual(marketGuideBlock(viaWhatsApp).indexOf("MARKET GUIDE"), -1, "WhatsApp must show a Market Guide");
  assert.equal(marketGuideBlock(viaWhatsApp), marketGuideBlock(viaTelegram), "the same request must produce the same Market Guide regardless of channel");
});

test("required: equivalent natural-language phrasings that state the same reference all resolve to the same canonical reference and the same Market Guide data", async (t) => {
  const phones = ["19992220020", "19992220021", "19992220022"];
  for (const phone of phones) resetState(phone);
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  mockSends(t);

  const prices = [23800, 24700, 25900];
  for (const [i, price] of prices.entries()) {
    await postingsDb.withSchema((pool) =>
      pool.query(
        `INSERT INTO postings (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,price,currency,contact_phone,status,expires_at)
         VALUES ('whatsapp','chat','other-group',$1,NULL,'FS','fixture','116500LN',$2,'USD',$3,'active',now()+interval '1 day')`,
        [`phrasing-fixture-${i}`, price, `phrasing-seller-${i}`]
      )
    );
  }

  // Spec's example phrasings that state an explicit reference number — these must converge on
  // the same canonical reference (116500LN) and therefore the same underlying Market Guide data,
  // regardless of how the rest of the sentence is worded.
  const phrasings = [
    "Sell Rolex 116500LN for $24,500",
    "I want to sell my 116500LN for $24,500.",
    "FS 116500LN black 2022 preowned full set 24.5k Miami",
  ];

  const marketGuideBlock = (s: string) => s.slice(s.indexOf("MARKET GUIDE"));
  const blocks: string[] = [];
  for (const [i, phrasing] of phrasings.entries()) {
    const phone = phones[i];
    await handleIncomingMessage(phone, "hi");
    let reply = await handleIncomingMessage(phone, phrasing);
    // Each phrasing states a different subset of slots; answer whichever ones are still missing
    // (dial/condition/location/photo) so every phrasing reaches the same review step regardless
    // of which details it happened to state up front.
    for (let guard = 0; guard < 5 && !/MARKET GUIDE/.test(reply.messages.join("\n")); guard++) {
      const last = reply.messages.join("\n");
      if (/black dial, white dial/i.test(last)) reply = await handleIncomingMessage(phone, "black");
      else if (/What condition/i.test(last)) reply = await handleIncomingMessage(phone, "pre-owned");
      else if (/Where is the watch located/i.test(last)) reply = await handleIncomingMessage(phone, "Miami");
      else if (/attach a photo/i.test(last)) reply = await handleIncomingMessage(phone, "skip");
      else break;
    }
    const combined = reply.messages.join("\n");
    assert.equal(reply.state.pendingSellIntake?.reference, "116500LN", `"${phrasing}" must resolve reference 116500LN`);
    assert.match(combined, /MARKET GUIDE/, `"${phrasing}" must show a Market Guide`);
    blocks.push(marketGuideBlock(combined).split("\n").slice(0, 5).join("\n"));
  }
  assert.equal(blocks[0], blocks[1], "same reference must produce the same Market Guide numbers regardless of phrasing");
  assert.equal(blocks[0], blocks[2], "same reference must produce the same Market Guide numbers regardless of phrasing");
});

test("known limitation: a phrasing that never states a reference number or the brand name asks for the reference rather than guessing one from the model alone", async (t) => {
  const phone = "19992220023"; resetState(phone); await inventoryDb._resetDbForTests(); await postingsDb._resetDbForTests(); mockSends(t);
  await handleIncomingMessage(phone, "hi");
  const result = await handleIncomingMessage(phone, "I've got a 2022 Daytona black dial full set. Want 24.5.");
  const text = result.messages.join("\n");
  // "Daytona" alone does not uniquely determine a reference (116500LN, 116503, 116508, etc. all
  // exist), so Fi asks rather than assuming the current ceramic-bezel steel model — guessing here
  // would risk exactly the "fake precision" the spec elsewhere prohibits.
  assert.doesNotMatch(text, /MARKET GUIDE/);
  assert.equal(result.state.pendingSellIntake?.reference, undefined);
});
