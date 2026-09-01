import assert from "node:assert/strict";
import test from "node:test";
import type { PostingRow } from "./postingsStore";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { formatMatchMessage } = require("./notify") as typeof import("./notify");

function posting(overrides: Partial<PostingRow>): PostingRow {
  return { id: 1, source_platform: "whatsapp", source_type: "direct", source_chat_id: null,
    source_message_id: null, external_listing_id: null, canonical_user_id: 1, source_identity: "1",
    type: "FS", original_text: "Rolex Daytona 116500LN", brand: "Rolex", model: "Daytona",
    reference: "116500LN", dial: "Black", year: "2023", condition: "New", box_papers: "Full set",
    price: "28500", currency: "USD", location: "Miami, USA", contact_name: "ABC Watches",
    contact_phone: "1", detail_url: "https://example.test/listing", status: "active", approved_match_count: 0,
    expires_at: "2030-01-01T00:00:00Z", reminder_sent_for_expires_at: null, ...overrides };
}

test("match cards contain decision context, dealer identity, product details, source, and photo", () => {
  const message = formatMatchMessage(413, posting({ type: "WTB" }), posting({}), ["Exact reference"], "https://example.test/photo.jpg");
  assert.match(message, /Potential Match 413/);
  assert.match(message, /Seller: ABC Watches/);
  assert.match(message, /Rolex Daytona 116500LN/);
  assert.match(message, /Dial: Black/);
  assert.match(message, /Year: 2023/);
  assert.match(message, /Box\/papers: Full set/);
  assert.match(message, /Price: \$28,500/);
  assert.match(message, /Condition: New/);
  assert.match(message, /Location: Miami, USA/);
  assert.match(message, /Source: https:\/\/example\.test\/listing/);
  assert.match(message, /Photo: https:\/\/example\.test\/photo\.jpg/);
  assert.match(message, /approve 413/);
});
