import assert from "node:assert/strict";
import test from "node:test";
import { countRelevant, duePeriod, formatDigest, isRelevant, localClock, marketSentiment, shouldSendDigest } from "./marketUpdates";
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

test("both local schedules and DST are calculated in America/New_York", () => {
  assert.deepEqual(duePeriod(new Date("2026-01-15T14:00:00Z"), "America/New_York", "09:00", "16:00"), { period: "morning", localDate: "2026-01-15" });
  assert.deepEqual(duePeriod(new Date("2026-07-15T20:00:00Z"), "America/New_York", "09:00", "16:00"), { period: "afternoon", localDate: "2026-07-15" });
  assert.equal(localClock(new Date("2026-03-08T13:00:00Z"), "America/New_York").time, "09:00");
  assert.equal(duePeriod(new Date("2026-07-15T19:59:00Z"), "America/New_York", "09:00", "16:00"), null);
});

test("scheduler restart recovery is limited to the configurable one-hour grace window", () => {
  assert.deepEqual(
    duePeriod(new Date("2026-01-15T14:01:00Z"), "America/New_York", "09:00", "16:00", 60),
    { period: "morning", localDate: "2026-01-15" },
    "a restart at 09:01 recovers the morning digest"
  );
  assert.deepEqual(
    duePeriod(new Date("2026-01-15T14:59:00Z"), "America/New_York", "09:00", "16:00", 60),
    { period: "morning", localDate: "2026-01-15" },
    "a restart within the grace window recovers the digest"
  );
  assert.equal(
    duePeriod(new Date("2026-01-15T15:01:00Z"), "America/New_York", "09:00", "16:00", 60),
    null,
    "a morning digest is never sent outside the one-hour grace window"
  );
  assert.equal(
    duePeriod(new Date("2026-01-15T14:01:00Z"), "America/New_York", "09:00", "16:00", 0),
    null,
    "operators can disable restart recovery"
  );
});

test("multiple watches are combined with aggregate-only, 15-day-safe copy", () => {
  const text = formatDigest([
    { postingId: 1, type: "FS", brand: "Patek Philippe", model: "", reference: "5712G", buyers: 8, sellers: 3, newMatches: 2 },
    { postingId: 2, type: "WTB", brand: "Rolex", model: "", reference: "126500LN", buyers: 12, sellers: 5, newMatches: 0 },
  ], 3);
  assert.match(text, /Patek Philippe 5712G listing/);
  assert.match(text, /Rolex 126500LN search/);
  assert.equal((text.match(/past 15 days/g) ?? []).length, 2);
  assert.doesNotMatch(text, /private|phone|group|budget|photo|100/);
});

test("no-activity and unchanged digests are suppressed unless explicitly allowed", () => {
  const quiet = [{ postingId: 1, type: "WTB" as const, brand: "Rolex", model: "Daytona", reference: "126500LN", buyers: 0, sellers: 0, newMatches: 0 }];
  assert.equal(shouldSendDigest(quiet, null, false), false);
  assert.equal(shouldSendDigest(quiet, null, true), true);
  const active = [{ ...quiet[0], sellers: 2 }];
  assert.equal(shouldSendDigest(active, null, false), true);
  const crypto = require("crypto");
  const prior = crypto.createHash("sha256").update(JSON.stringify([[1, 0, 2]])).digest("hex");
  assert.equal(shouldSendDigest(active, prior, false), false);
  assert.equal(shouldSendDigest([{ ...active[0], newMatches: 1 }], prior, false), true);
});
