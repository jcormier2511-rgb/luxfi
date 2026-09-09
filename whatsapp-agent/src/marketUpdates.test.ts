import assert from "node:assert/strict";
import test from "node:test";
import { countRelevant, dueWeekly, formatDigest, isRelevant, localClock, marketSentiment, shouldSendDigest } from "./marketUpdates";
import { PostingRow } from "./postings/postingsStore";

const future = "2030-01-20T00:00:00.000Z";
function posting(overrides: Partial<PostingRow> = {}): PostingRow {
  return {
    id: 1, source_platform: "whatsapp", source_type: "chat", source_chat_id: "g", source_message_id: "m",
    external_listing_id: null, canonical_user_id: 1, source_identity: "100", type: "WTB", original_text: "WTB Rolex Daytona 126500LN",
    brand: "Rolex", model: "Daytona", reference: "126500LN", condition: "", price: null, currency: "USD", location: "",
    contact_name: "private", contact_phone: "100", detail_url: "", status: "active", approved_match_count: 0,
    expires_at: future, reminder_sent_for_expires_at: null, ...overrides,
  };
}

test("market counting uses exact references and never brand-only matching", () => {
  const subject = posting();
  assert.equal(isRelevant(subject, posting({ reference: "126500LN", type: "FS" })), true);
  assert.equal(isRelevant(subject, posting({ reference: "116500LN", type: "FS" })), false);
  assert.equal(isRelevant(subject, posting({ reference: "", type: "FS" })), false);
});

test("brand/model fallback applies only to a subject without a reference", () => {
  const subject = posting({ reference: "", original_text: "WTB Rolex Daytona", model: "Daytona" });
  assert.equal(isRelevant(subject, posting({ reference: "116500LN", model: "Daytona", type: "FS" })), true);
  assert.equal(isRelevant(subject, posting({ reference: "", model: "Submariner", original_text: "FS Rolex Submariner", type: "FS" })), false);
});

test("counts unique users/listings, excludes recipient, expired boundary, and closed records", () => {
  const now = new Date("2030-01-05T00:00:00Z");
  const subject = posting();
  const rows = [
    posting({ id: 2, canonical_user_id: 2, source_identity: "200", type: "WTB" }),
    posting({ id: 3, canonical_user_id: 2, source_identity: "200", type: "WTB" }),
    posting({ id: 4, canonical_user_id: 3, type: "FS" }),
    posting({ id: 5, canonical_user_id: 1, type: "FS" }),
    posting({ id: 6, canonical_user_id: 4, type: "FS", expires_at: now.toISOString() }),
    posting({ id: 7, canonical_user_id: 5, type: "FS", status: "sold" }),
    posting({ id: 8, canonical_user_id: null, source_identity: null, contact_phone: "", type: "FS" }),
    posting({ id: 9, canonical_user_id: null, source_identity: null, contact_phone: "", type: "FS" }),
  ];
  assert.deepEqual(countRelevant(subject, rows, 1, now), { buyers: 1, sellers: 3 });
});

test("sentiment thresholds and minimum observation count are deterministic", () => {
  assert.equal(marketSentiment(1, 0, 3), "Not enough recent activity to determine sentiment.");
  assert.equal(marketSentiment(4, 2, 3), "Demand currently exceeds supply.");
  assert.equal(marketSentiment(2, 4, 3), "Supply currently exceeds demand.");
  assert.equal(marketSentiment(4, 3, 3), "Supply and demand appear balanced.");
});

test("due once a week, at the configured local day and time, DST-safe in America/New_York", () => {
  // 2026-01-16 (winter, EST, UTC-5) and 2026-07-17 (summer, EDT, UTC-4) are both Fridays.
  assert.deepEqual(dueWeekly(new Date("2026-01-16T21:00:00Z"), "America/New_York", "Friday", "16:00"), { localDate: "2026-01-16" });
  assert.deepEqual(dueWeekly(new Date("2026-07-17T20:00:00Z"), "America/New_York", "Friday", "16:00"), { localDate: "2026-07-17" });
  assert.equal(localClock(new Date("2026-03-08T13:00:00Z"), "America/New_York").time, "09:00");
  assert.equal(dueWeekly(new Date("2026-07-17T19:59:00Z"), "America/New_York", "Friday", "16:00"), null, "not yet due before the configured time");
});
test("the right time on the wrong day, or the right day at the wrong time, is never due", () => {
  // 2026-01-15 is a Thursday, the day right before the Friday used above.
  assert.equal(dueWeekly(new Date("2026-01-15T21:00:00Z"), "America/New_York", "Friday", "16:00"), null, "right time, wrong day");
  assert.equal(dueWeekly(new Date("2026-01-16T14:00:00Z"), "America/New_York", "Friday", "16:00"), null, "right day, wrong time");
  assert.deepEqual(dueWeekly(new Date("2026-01-16T21:00:00Z"), "America/New_York", "friday", "16:00"), { localDate: "2026-01-16" }, "day-of-week match is case-insensitive");
});

test("scheduler restart recovery is limited to the configurable one-hour grace window", () => {
  assert.deepEqual(
    dueWeekly(new Date("2026-01-16T21:01:00Z"), "America/New_York", "Friday", "16:00", 60),
    { localDate: "2026-01-16" },
    "a restart one minute late still recovers the weekly digest"
  );
  assert.deepEqual(
    dueWeekly(new Date("2026-01-16T21:59:00Z"), "America/New_York", "Friday", "16:00", 60),
    { localDate: "2026-01-16" },
    "a restart within the grace window recovers the digest"
  );
  assert.equal(
    dueWeekly(new Date("2026-01-16T22:01:00Z"), "America/New_York", "Friday", "16:00", 60),
    null,
    "a weekly digest is never sent outside the one-hour grace window"
  );
  assert.equal(
    dueWeekly(new Date("2026-01-16T21:01:00Z"), "America/New_York", "Friday", "16:00", 0),
    null,
    "operators can disable restart recovery"
  );
});

test("required: renamed and restyled -- 'Market Edge' must read as a different message from the free daily briefing, not a repeat of it", () => {
  const text = formatDigest([{ postingId: 1, type: "FS", brand: "Patek Philippe", model: "", reference: "5712G", buyers: 8, sellers: 3, newMatches: 2, averageFsAsk: null, priceDelta: null }], 3);
  assert.match(text, /^📈 Market Edge — your weekly watch market update/);
  assert.doesNotMatch(text, /Your LuxFi market update|Good morning|Here's your Fi update/);
});

test("multiple watches are combined, numbered, with aggregate-only counts (no private contact info)", () => {
  const text = formatDigest([
    { postingId: 1, type: "FS", brand: "Patek Philippe", model: "", reference: "5712G", buyers: 8, sellers: 3, newMatches: 2, averageFsAsk: null, priceDelta: null },
    { postingId: 2, type: "WTB", brand: "Rolex", model: "", reference: "126500LN", buyers: 12, sellers: 5, newMatches: 0, averageFsAsk: null, priceDelta: null },
  ], 3);
  assert.match(text, /1\. 🏷️ Patek Philippe 5712G\n👥 8 buyers · 3 sellers \(network-wide\)/);
  assert.match(text, /2\. 🔍 Rolex 126500LN\n👥 12 buyers · 5 sellers \(network-wide\)/);
  assert.match(text, /✨ 2 new matches this week!/);
  assert.match(text, /✨ No new matches this week\./);
  assert.match(text, /\n\n🔗 See live listings: watchfacts\.com$/, "every digest ends by pointing at the live inventory");
  assert.doesNotMatch(text, /private|phone|group|budget|photo|100/);
});

test("a count of one never reads as a plural — the prose it replaced said \"1 active buyers\"", () => {
  const text = formatDigest([{ postingId: 3, type: "WTB", brand: "Rolex", model: "Daytona", reference: "116500LN", buyers: 1, sellers: 1, newMatches: 1, averageFsAsk: null, priceDelta: null }], 3);
  assert.match(text, /👥 1 buyer · 1 seller \(network-wide\)/);
  assert.match(text, /✨ 1 new match this week!/);
  assert.doesNotMatch(text, /1 active buyers|1 active sellers|1 buyers|1 sellers|1 new matches/);
});

test("required: shows the average ask, and its change since last week once there's a prior value to diff against", () => {
  const first = formatDigest([{ postingId: 1, type: "FS", brand: "Rolex", model: "Daytona", reference: "116500LN", buyers: 3, sellers: 8, newMatches: 0, averageFsAsk: 29800, priceDelta: null }], 3);
  assert.match(first, /💰 Avg ask: \$29,800\n/, "no invented delta on the first run for this posting");
  const later = formatDigest([{ postingId: 1, type: "FS", brand: "Rolex", model: "Daytona", reference: "116500LN", buyers: 3, sellers: 8, newMatches: 0, averageFsAsk: 29800, priceDelta: 650 }], 3);
  assert.match(later, /💰 Avg ask: \$29,800 \(\+\$650 this week\)/);
  const dropped = formatDigest([{ postingId: 1, type: "FS", brand: "Rolex", model: "Daytona", reference: "116500LN", buyers: 3, sellers: 8, newMatches: 0, averageFsAsk: 29800, priceDelta: -400 }], 3);
  assert.match(dropped, /💰 Avg ask: \$29,800 \(-\$400 this week\)/);
  const flat = formatDigest([{ postingId: 1, type: "FS", brand: "Rolex", model: "Daytona", reference: "116500LN", buyers: 3, sellers: 8, newMatches: 0, averageFsAsk: 29800, priceDelta: 0 }], 3);
  assert.match(flat, /💰 Avg ask: \$29,800 \(no change this week\)/);
});
test("required: an unresolvable average ask still shows Unavailable when there IS a reference, but the price line is omitted entirely when there's no reference at all", () => {
  const noComparables = formatDigest([{ postingId: 1, type: "FS", brand: "Rolex", model: "Daytona", reference: "116500LN", buyers: 0, sellers: 0, newMatches: 0, averageFsAsk: null, priceDelta: null }], 3);
  assert.match(noComparables, /💰 Avg ask: Unavailable\n/);
  const noReference = formatDigest([{ postingId: 2, type: "WTB", brand: "Rolex", model: "", reference: "", buyers: 0, sellers: 0, newMatches: 0, averageFsAsk: null, priceDelta: null }], 3);
  assert.doesNotMatch(noReference, /💰/);
});

test("no-activity and unchanged digests are suppressed unless explicitly allowed", () => {
  const quiet = [{ postingId: 1, type: "WTB" as const, brand: "Rolex", model: "Daytona", reference: "126500LN", buyers: 0, sellers: 0, newMatches: 0, averageFsAsk: null, priceDelta: null }];
  assert.equal(shouldSendDigest(quiet, null, false), false);
  assert.equal(shouldSendDigest(quiet, null, true), true);
  const active = [{ ...quiet[0], sellers: 2 }];
  assert.equal(shouldSendDigest(active, null, false), true);
  const crypto = require("crypto");
  const prior = crypto.createHash("sha256").update(JSON.stringify([[1, 0, 2, null]])).digest("hex");
  assert.equal(shouldSendDigest(active, prior, false), false);
  assert.equal(shouldSendDigest([{ ...active[0], newMatches: 1 }], prior, false), true);
  assert.equal(shouldSendDigest([{ ...active[0], averageFsAsk: 30000 }], prior, false), true, "a price-only change must still count as changed, not be suppressed");
});
