import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getOrCreateCanonicalUser } = require("./identity") as typeof import("./identity");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const notificationPreferences = require("./notificationPreferences") as typeof import("./notificationPreferences");
const {
  getNotificationPreference,
  setPreferredChannel,
  setFallbackEnabled,
  getLinkedIdentities,
  linkIdentity,
  createPendingIdentityLink,
  consumePendingIdentityLink,
  resolveNotifyIdentity,
  resolveFallbackIdentity,
  channelLabel,
} = notificationPreferences;

after(() => db._closePoolForTests());

test("a canonical user with no stated preference has no preferred channel and no fallback", async () => {
  await db._resetDbForTests();
  const user = await getOrCreateCanonicalUser("whatsapp", "15551110001");
  const pref = await getNotificationPreference(user);
  assert.deepEqual(pref, { preferredChannel: null, fallbackEnabled: false, wtbAlertsPaused: false });
});

test("setPreferredChannel and setFallbackEnabled persist independently of each other", async () => {
  await db._resetDbForTests();
  const user = await getOrCreateCanonicalUser("telegram", "telegram:1");

  await setPreferredChannel(user, "sms");
  assert.equal((await getNotificationPreference(user)).preferredChannel, "sms");

  await setFallbackEnabled(user, true);
  const pref = await getNotificationPreference(user);
  assert.equal(pref.fallbackEnabled, true, "enabling fallback must not clear the channel already set");
  assert.equal(pref.preferredChannel, "sms");

  await setPreferredChannel(user, "telegram");
  assert.equal((await getNotificationPreference(user)).fallbackEnabled, true, "changing the channel must not clear fallback");
});

test("linkIdentity attaches a brand-new identity to an existing canonical user", async () => {
  await db._resetDbForTests();
  const user = await getOrCreateCanonicalUser("telegram", "telegram:2001");

  const result = await linkIdentity(user, "sms", "sms:+15551112222");
  assert.deepEqual(result, { ok: true });

  const linked = await getLinkedIdentities(user);
  assert.equal(linked.length, 2);
  assert.ok(linked.some((l) => l.platform === "sms" && l.identity === "sms:+15551112222"));
});

test("linkIdentity refuses to attach an identity already linked to a DIFFERENT canonical user", async () => {
  await db._resetDbForTests();
  const userA = await getOrCreateCanonicalUser("whatsapp", "15553330001");
  await getOrCreateCanonicalUser("telegram", "telegram:3002"); // userB, owns this identity below

  const result = await linkIdentity(userA, "telegram", "telegram:3002");
  assert.deepEqual(result, { ok: false, reason: "already_linked_elsewhere" });
});

test("linkIdentity reports already_linked_here rather than erroring on a harmless repeat", async () => {
  await db._resetDbForTests();
  const user = await getOrCreateCanonicalUser("whatsapp", "15554440001");
  const result = await linkIdentity(user, "whatsapp", "15554440001");
  assert.deepEqual(result, { ok: false, reason: "already_linked_here" });
});

test("resolveNotifyIdentity prefers the identity matching the stated channel, and never drops a notification when it's unlinked", async () => {
  await db._resetDbForTests();
  const user = await getOrCreateCanonicalUser("whatsapp", "15555550001");
  await linkIdentity(user, "telegram", "telegram:5001");

  // No preference yet -- the only meaningful behavior is "whichever is linked" (oldest first).
  assert.equal(await resolveNotifyIdentity(user), "15555550001");

  await setPreferredChannel(user, "telegram");
  assert.equal(await resolveNotifyIdentity(user), "telegram:5001", "prefers the linked identity matching the stated channel");

  // Stated preference for a channel that ISN'T linked yet must still resolve to what IS linked
  // rather than returning null and silently dropping the notification.
  await setPreferredChannel(user, "sms");
  assert.equal(await resolveNotifyIdentity(user), "15555550001");
});

test("resolveNotifyIdentity returns null only when nothing at all is linked", async () => {
  await db._resetDbForTests();
  // An API-mirrored FS listing's canonical user, or any other with no chat identity ever.
  assert.equal(await resolveNotifyIdentity(999999), null);
});

test("resolveFallbackIdentity finds another linked identity, excluding the one that just failed", async () => {
  await db._resetDbForTests();
  const user = await getOrCreateCanonicalUser("whatsapp", "15556660001");
  await linkIdentity(user, "telegram", "telegram:6001");

  assert.equal(await resolveFallbackIdentity(user, "15556660001"), "telegram:6001");
  assert.equal(await resolveFallbackIdentity(user, "telegram:6001"), "15556660001");
});

test("resolveFallbackIdentity returns null when the failed identity is the only one linked", async () => {
  await db._resetDbForTests();
  const user = await getOrCreateCanonicalUser("whatsapp", "15557770001");
  assert.equal(await resolveFallbackIdentity(user, "15557770001"), null);
});

test("a Telegram link code is single-use, platform-scoped, and links the identity that consumes it", async () => {
  await db._resetDbForTests();
  const user = await getOrCreateCanonicalUser("whatsapp", "15558880001");
  const code = await createPendingIdentityLink(user, "telegram");
  assert.match(code, /^[0-9A-F]{8}$/);

  // Wrong platform is rejected without consuming the code.
  assert.deepEqual(await consumePendingIdentityLink(code, "sms"), { ok: false, reason: "wrong_platform" });

  const consumed = await consumePendingIdentityLink(code, "telegram");
  assert.deepEqual(consumed, { ok: true, canonicalUserId: user });

  // Single-use: the same code can never be consumed again, even for the right platform.
  assert.deepEqual(await consumePendingIdentityLink(code, "telegram"), { ok: false, reason: "not_found" });
});

test("an unknown link code is rejected", async () => {
  await db._resetDbForTests();
  assert.deepEqual(await consumePendingIdentityLink("DEADBEEF", "telegram"), { ok: false, reason: "not_found" });
});

test("channelLabel gives a human-readable name for each platform", () => {
  assert.equal(channelLabel("whatsapp"), "WhatsApp");
  assert.equal(channelLabel("telegram"), "Telegram");
  assert.equal(channelLabel("sms"), "SMS");
});
