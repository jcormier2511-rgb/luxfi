import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Deliberately avoids t.mock.method (broken in this sandbox for every test file that uses it --
// "The argument 'methodName' must be a method. Received undefined") by relying on the real,
// deterministic no-op behavior whapi/client.ts's post() already has when WHAPI_TOKEN is unset: it
// logs via console.warn instead of making a live call. Intercepting console.warn observes exactly
// which outbound sends actually happened, in order, without needing any mock framework at all.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-server-photointercept-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET ?? "test-admin-session-secret";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("./postings/db") as typeof import("./postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState, getState } = require("./conversation/stateStore") as typeof import("./conversation/stateStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { requestPhotosForMatch } = require("./matching/photoRequests") as typeof import("./matching/photoRequests");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const server = require("./server") as typeof import("./server");

after(async () => {
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

let calls: { path: string; body: any }[] = [];
let originalWarn: typeof console.warn;
beforeEach(() => {
  calls = [];
  originalWarn = console.warn;
  console.warn = (...args: any[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[whapi] WHAPI_TOKEN not set")) {
      const p = args[0].match(/skipping live call to (\S+?)\.?\s+Payload/)?.[1];
      calls.push({ path: p ?? "?", body: args[1] });
      return;
    }
    originalWarn(...args);
  };
});
process.on("exit", () => { if (originalWarn) console.warn = originalWarn; });

async function seedPendingPhotoRequest(sellerPhone: string, requesterPhone: string) {
  await inventoryDb.upsertListings(
    [{
      id: "intercept-1", type: "FS", category: "watches", item: "Rolex Daytona 116500LN",
      brand: "Rolex", ref: "116500LN", condition: "Used", price: "28000", location: "North America",
      contactName: "Seller", contactPhone: sellerPhone, rating: "4", description: "Rolex Daytona 116500LN",
    }],
    new Date().toISOString()
  );
  const listing = { id: "intercept-1", type: "FS" as const, source: "WF", contactPhone: sellerPhone, contactName: "Seller", item: "Rolex Daytona 116500LN", brand: "Rolex", ref: "116500LN" } as any;
  const outcome = await requestPhotosForMatch(requesterPhone, listing, 1);
  assert.equal(outcome, "sent", "precondition: the v3 photo-request record must exist for this seller's phone");
}

/**
 * Live-reported bug: a photo sent to answer the sell-intake draft's OWN "Would you like to
 * attach a photo?" question got silently swallowed with NO reply at all. Root cause:
 * handleIncomingSellerPhoto (server.ts, imported from matching/photoRequests.ts) runs BEFORE the
 * normal conversation flow and intercepts ANY image from a phone that has a pending v3
 * "photos requested" record -- however old or unrelated to what the sender is doing right now --
 * forwarding it to the ORIGINAL REQUESTER and never replying to the sender at all. This is
 * exactly the kind of stale state a single heavily-reused test/live number accumulates across
 * many different flows over a session.
 */
test("required regression: a photo answering an OPEN sell-intake photo step is never swallowed by an unrelated pending v3 photo request for the same phone", async () => {
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();

  const sellerPhone = "19992221000";
  const requesterPhone = "19992221001";
  resetState(sellerPhone);

  await seedPendingPhotoRequest(sellerPhone, requesterPhone);

  await server.processIncomingMessages([{ id: "s1", phone: sellerPhone, text: "hi", isGroup: false }]);
  await server.processIncomingMessages([{ id: "s2", phone: sellerPhone, text: "FS Rolex Submariner 116610LN black dial $12,000 pre-owned in USA", isGroup: false }]);
  assert.equal(getState(sellerPhone).pendingSellIntake?.step, "photo", "precondition: the draft must be waiting on its own photo");

  calls.length = 0;
  await server.processIncomingMessages([{ id: "s3", phone: sellerPhone, text: "", isGroup: false, imageUrl: "https://cdn.example/my-submariner.jpg" }]);

  const state = getState(sellerPhone);
  assert.equal(state.pendingSellIntake?.imageUrl, "https://cdn.example/my-submariner.jpg", "the photo must be attached to the seller's OWN open draft");
  assert.equal(state.pendingSellIntake?.step, "confirm", "the draft must advance past its own photo step");

  // The seller must see SOMETHING back -- never total silence.
  const toSeller = calls.filter((c) => c.body?.to === sellerPhone);
  assert.ok(toSeller.length > 0, "the seller who sent the photo must receive a reply, not silence");

  // And the unrelated requester must NOT have received this seller's photo -- it was never an
  // answer to their (different, stale) photo request.
  const toRequester = calls.filter((c) => c.body?.to === requesterPhone);
  assert.equal(toRequester.length, 0, "an unrelated party must never receive a photo that was actually answering someone else's own draft");
});

test("sanity: a photo genuinely answering an open v3 photo request is still routed there when no sell-intake draft is open", async () => {
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();

  const sellerPhone = "19992221002";
  const requesterPhone = "19992221003";
  resetState(sellerPhone);

  await seedPendingPhotoRequest(sellerPhone, requesterPhone);

  calls.length = 0;
  await server.processIncomingMessages([{ id: "sanity-1", phone: sellerPhone, text: "", isGroup: false, imageUrl: "https://cdn.example/real-answer.jpg" }]);

  const toRequester = calls.filter((c) => c.path === "/messages/image" && c.body?.to === requesterPhone);
  assert.equal(toRequester.length, 1, "with no competing open draft, the existing v3 photo-request routing must be completely unaffected");
  assert.equal(toRequester[0].body.media, "https://cdn.example/real-answer.jpg");
});
