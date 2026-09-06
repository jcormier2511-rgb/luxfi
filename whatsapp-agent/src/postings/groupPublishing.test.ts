import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { savePushGroup } = require("./listingConfig") as typeof import("./listingConfig");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createDirectPosting, setPostingImages } = require("./postingsStore") as typeof import("./postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { publishConfirmedListing } = require("./groupPublishing") as typeof import("./groupPublishing");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const channels = require("../channels") as typeof import("../channels");

beforeEach(async () => {
  await db._resetDbForTests(); // drops listing_push_groups/listing_settings/listing_group_publications too
});
after(async () => {
  await db._closePoolForTests();
});

test("a listing with no photo pushes as plain text", async (t) => {
  await savePushGroup({ group_id: "wa-group-1", group_name: "Miami Dealers", platform: "whatsapp", enabled: true, allow_fs: true, allow_wtb: true, priority: 100 });
  const sent: { identity: string; text?: string; imageUrl?: string; caption?: string }[] = [];
  t.mock.method(channels, "sendText", async (identity: string, text: string) => { sent.push({ identity, text }); });
  t.mock.method(channels, "sendBannerImage", async (identity: string, imageUrl: string, caption?: string) => { sent.push({ identity, imageUrl, caption }); });

  const posting = await createDirectPosting({ phone: "15550009001", type: "FS", description: "Rolex Daytona 116500LN", brand: "Rolex", reference: "116500LN", price: 28500 });
  await publishConfirmedListing(posting);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].identity, "wa-group-1");
  assert.ok(sent[0].text?.includes("116500LN"));
  assert.equal(sent[0].imageUrl, undefined, "no image on the posting means a plain text send, not sendBannerImage");
});

test("a listing WITH a photo pushes via sendBannerImage, using the formatted listing as the caption", async (t) => {
  await savePushGroup({ group_id: "tg-group-1", group_name: "Asia Dealers", platform: "telegram", enabled: true, allow_fs: true, allow_wtb: true, priority: 100 });
  const sent: { identity: string; text?: string; imageUrl?: string; caption?: string }[] = [];
  t.mock.method(channels, "sendText", async (identity: string, text: string) => { sent.push({ identity, text }); });
  t.mock.method(channels, "sendBannerImage", async (identity: string, imageUrl: string, caption?: string) => { sent.push({ identity, imageUrl, caption }); });

  const posting = await createDirectPosting({ phone: "15550009002", type: "FS", description: "Rolex Daytona 116500LN", brand: "Rolex", reference: "116500LN", price: 28500 });
  await setPostingImages(posting.id, ["https://cdn.example/daytona.jpg"]);
  await publishConfirmedListing(posting);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].identity, "tg-group-1");
  assert.equal(sent[0].imageUrl, "https://cdn.example/daytona.jpg");
  assert.ok(sent[0].caption?.includes("116500LN"));
  assert.equal(sent[0].text, undefined, "an image present means sendBannerImage, not sendText");
});

test("an oversized caption falls back to plain text even when a photo is present", async (t) => {
  await savePushGroup({ group_id: "wa-group-2", group_name: "Overflow Group", platform: "whatsapp", enabled: true, allow_fs: true, allow_wtb: true, priority: 100 });
  const sent: { identity: string; text?: string; imageUrl?: string }[] = [];
  t.mock.method(channels, "sendText", async (identity: string, text: string) => { sent.push({ identity, text }); });
  t.mock.method(channels, "sendBannerImage", async (identity: string, imageUrl: string) => { sent.push({ identity, imageUrl }); });

  const posting = await createDirectPosting({ phone: "15550009003", type: "FS", description: "x".repeat(1200), brand: "Rolex", reference: "116500LN", price: 28500, notes: "x".repeat(1200) });
  await setPostingImages(posting.id, ["https://cdn.example/daytona.jpg"]);
  await publishConfirmedListing(posting);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].imageUrl, undefined, "an over-length caption must fall back to sendText, never risk a truncated/rejected caption");
  assert.ok(sent[0].text);
});

test("no eligible push groups means nothing is sent", async (t) => {
  const sent: unknown[] = [];
  t.mock.method(channels, "sendText", async () => { sent.push(true); });
  t.mock.method(channels, "sendBannerImage", async () => { sent.push(true); });

  const posting = await createDirectPosting({ phone: "15550009004", type: "FS", description: "Rolex Daytona 116500LN", brand: "Rolex", reference: "116500LN", price: 28500 });
  await publishConfirmedListing(posting);

  assert.equal(sent.length, 0);
});
