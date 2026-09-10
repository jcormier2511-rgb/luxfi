import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.PERSIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-phantom-companion-test-"));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isSuspectedPhantomCompanion, isSuspectedOutboundEcho, recordOutboundActivity, _resetPhantomCompanionForTests } = require("./stateStore") as typeof import("./stateStore");

beforeEach(() => {
  _resetPhantomCompanionForTests();
});

/**
 * Real reported bug, still not fully root-caused: every genuine WhatsApp text message is
 * followed by a SECOND webhook delivery -- same phone, same instant, a different id, with no
 * text and no image -- confirmed via production [whapi] raw logs. This is the stopgap that
 * suppresses that companion until the exact message `type` it carries is identified.
 */
test("required regression: a content-less message arriving right after a real one from the same phone is flagged as a suspected phantom companion", () => {
  assert.equal(isSuspectedPhantomCompanion("15551234567", "Hi, I want to join LuxFi network"), false, "the real message itself is never flagged");
  assert.equal(isSuspectedPhantomCompanion("15551234567", "", undefined), true, "an empty companion right after it is the exact observed pattern");
});

test("a content-less message with no preceding real message is never flagged -- id-based dedup alone applies to those", () => {
  assert.equal(isSuspectedPhantomCompanion("15551234567", "", undefined), false);
});

test("two different phones never interfere with each other", () => {
  isSuspectedPhantomCompanion("15551234567", "hi");
  assert.equal(isSuspectedPhantomCompanion("15559876543", "", undefined), false, "a content-less message from a DIFFERENT phone must never be blamed on someone else's real message");
});

test("a content-less message with an image is never flagged -- an uncaptioned photo reply is real content, not a phantom", () => {
  isSuspectedPhantomCompanion("15551234567", "please send photos");
  assert.equal(isSuspectedPhantomCompanion("15551234567", "", "https://cdn.example/a.jpg"), false);
});

/**
 * Real reported bug: this exact fallback ("I'm not sure I understood that") also arrived right
 * after a scheduled morning briefing -- an OUTBOUND-only send with no preceding inbound message
 * anywhere nearby, so isSuspectedPhantomCompanion had no recorded activity to compare the
 * phantom against and let it through. Every outbound send now feeds this same window (see
 * channels/index.ts's sendText/sendBannerImage).
 */
test("required regression: a content-less message arriving right after Fi's OWN outbound send (no inbound message nearby) is flagged as a suspected phantom companion", () => {
  recordOutboundActivity("15551234567");
  assert.equal(isSuspectedPhantomCompanion("15551234567", "", undefined), true, "a phantom right after an outbound-only send (e.g. a scheduled morning briefing) is now recognized");
});

test("recordOutboundActivity never flags a genuinely separate later message, and never crosses phones", () => {
  recordOutboundActivity("15551234567");
  assert.equal(isSuspectedPhantomCompanion("15559876543", "", undefined), false, "a different phone's content-less message is never blamed on someone else's outbound send");

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 10_000;
    assert.equal(isSuspectedPhantomCompanion("15551234567", "", undefined), false, "well outside the window, unrelated to the earlier outbound send");
  } finally {
    Date.now = realNow;
  }
});

test("the phantom window expires -- a genuinely separate content-less message sent well after is not flagged", async () => {
  isSuspectedPhantomCompanion("15551234567", "hi");
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 10_000;
    assert.equal(isSuspectedPhantomCompanion("15551234567", "", undefined), false, "well outside the window, a content-less message is treated as its own genuine message");
  } finally {
    Date.now = realNow;
  }
});

/**
 * Real reported bug, same still-unidentified family as the content-less phantom companion above,
 * but carrying real content: an inbound message that closely echoes Fi's OWN last outbound text.
 * Live-reported symptom: right after Fi sent a "CURRENT MARKET FOR "Rolex Daytona 116500LN" ...
 * Current sellers: ... Current buyers: ... Dealer asking range ..." reply, an inbound "message"
 * carrying that same content arrived and got treated as genuine input -- since it names a real
 * brand and reference, it read as a legitimate answer and corrupted the open sell draft's model
 * field with fragments spliced verbatim out of Fi's own reply.
 */
test("required regression: an inbound message that closely echoes Fi's own last outbound text is flagged as a suspected outbound echo", () => {
  const sent = 'CURRENT MARKET FOR "Rolex Daytona 116500LN"\n\nCurrent sellers: 3\nCurrent buyers: 0\nDealer asking range: $24,250–$25,300\nMedian dealer ask: $24,700';
  recordOutboundActivity("15551234567", sent);
  assert.equal(
    isSuspectedOutboundEcho("15551234567", "Current sellers: 3\nCurrent buyers: 0\nDealer asking range"),
    true,
    "a close copy of Fi's own last reply arriving as inbound text is recognized as the echo"
  );
});

test("a short reply is never mistaken for an echo, even if it happens to appear inside Fi's last message", () => {
  recordOutboundActivity("15551234567", "Would you like to attach a photo? Send it now, or reply \"skip\" or \"no photo\".");
  assert.equal(isSuspectedOutboundEcho("15551234567", "skip"), false, "a short, genuine reply must never be blocked just because it's a substring of Fi's own message");
  assert.equal(isSuspectedOutboundEcho("15551234567", "usa"), false);
});

test("an inbound message unrelated to Fi's last outbound text is never flagged", () => {
  recordOutboundActivity("15551234567", "CURRENT MARKET FOR \"Rolex Daytona 116500LN\"\n\nCurrent sellers: 3\nCurrent buyers: 0");
  assert.equal(
    isSuspectedOutboundEcho("15551234567", "Sell my Patek Philippe Nautilus 5711/1A pre-owned $85,000 in Hong Kong"),
    false,
    "a genuine, unrelated new request must never be blocked"
  );
});

test("with no prior outbound send, nothing is ever flagged as an echo", () => {
  assert.equal(isSuspectedOutboundEcho("15551234567", "Sell my Rolex Daytona 116500LN black dial, pre-owned, full set, Miami"), false);
});

test("the echo window expires -- a genuine later message that happens to resemble Fi's old reply is not flagged", () => {
  const sent = "CURRENT MARKET FOR \"Rolex Daytona 116500LN\"\n\nCurrent sellers: 3\nCurrent buyers: 0\nDealer asking range: $24,250-$25,300";
  recordOutboundActivity("15551234567", sent);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31 * 60 * 1000;
    assert.equal(isSuspectedOutboundEcho("15551234567", "Current sellers: 3\nCurrent buyers: 0"), false, "well outside the window, a resembling message is treated as genuine");
  } finally {
    Date.now = realNow;
  }
});

/**
 * Live-reported bug (the SAME "Current sellers:... Dealer asking range..." corruption
 * recurring in production): the original fix only ever compared against the single MOST RECENT
 * outbound text. A confirmed-live WHAPI delivery delay of over 20 minutes meant that by the time
 * the echoed Market Guide reply finally arrived, Fi had already sent a SECOND message in the same
 * turn (e.g. the photo question that normally follows it) -- overwriting the one thing the echo
 * would have matched against, so the delayed echo of the FIRST message sailed through undetected.
 */
test("required regression: a delayed echo of an EARLIER outbound message is still caught, even after Fi sent a second message in between", () => {
  const marketGuide = "CURRENT MARKET FOR \"Rolex Daytona 116500LN\"\n\nCurrent sellers: 3\nCurrent buyers: 0\nDealer asking range: $24,250-$25,300";
  recordOutboundActivity("15551234567", marketGuide);
  recordOutboundActivity("15551234567", "Would you like to attach a photo? Send it now, or reply \"skip\" or \"no photo\".");
  assert.equal(
    isSuspectedOutboundEcho("15551234567", "Current sellers: 3\nCurrent buyers: 0\nDealer asking range"),
    true,
    "the echo of the FIRST message must still be recognized, not missed just because a later message superseded it"
  );
});

/** A delayed echo arriving well within the widened window (but well outside the old 4-second
 *  one) must now be caught -- the exact live-reported timing this fix exists for. */
test("required regression: an echo delayed by several minutes -- confirmed live via WHAPI delivery lag -- is still caught", () => {
  const sent = "CURRENT MARKET FOR \"Rolex Daytona 116500LN\"\n\nCurrent sellers: 3\nCurrent buyers: 0\nDealer asking range: $24,250-$25,300";
  recordOutboundActivity("15551234567", sent);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 22 * 60 * 1000;
    assert.equal(
      isSuspectedOutboundEcho("15551234567", "Current sellers: 3\nCurrent buyers: 0\nDealer asking range"),
      true,
      "a 22-minute delay (the exact worst case confirmed live) must not slip past a too-short window"
    );
  } finally {
    Date.now = realNow;
  }
});
