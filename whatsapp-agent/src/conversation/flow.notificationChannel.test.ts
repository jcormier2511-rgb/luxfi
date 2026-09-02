import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";

const db = require("../postings/db") as typeof import("../postings/db");
const inventory = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
const { resetState } = require("./stateStore") as typeof import("./stateStore");
const { getOrCreateCanonicalUser } = require("../postings/identity") as typeof import("../postings/identity");
const notificationPreferences = require("../postings/notificationPreferences") as typeof import("../postings/notificationPreferences");

after(async () => { await db._closePoolForTests(); await inventory._closePoolForTests(); });
beforeEach(async () => { await db._resetDbForTests(); await inventory._resetDbForTests(); });

let counter = 0;
function freshPhone(): string {
  counter += 1;
  const phone = `whatsapp:551900800${String(counter).padStart(3, "0")}`;
  resetState(phone);
  return phone;
}

/**
 * Where you TALK to Fi and where Fi ALERTS you don't have to be the same channel. A dealer
 * might manage listings on Telegram but want matches pushed by SMS.
 */

// The preference itself is always recorded immediately, whatever it takes to actually reach
// that channel — a fresh WhatsApp-only phone has no SMS or Telegram identity linked YET, so
// those two also expect a linking prompt rather than "from now on" (covered in detail by the
// dedicated linking tests below); WhatsApp, the channel already chatting, needs neither.
for (const [message, expected, expectLinkingPrompt] of [
  ["Send my matches by SMS.", "sms", /phone number/i],
  ["Notify me on Telegram.", "telegram", /link\s+[0-9A-F]{8}/i],
  ["Use WhatsApp for alerts.", "whatsapp", /from now on/i],
] as const) {
  test(`"${message}" sets the preferred notification channel to ${expected}`, async () => {
    const phone = freshPhone();
    const reply = await handleIncomingMessage(phone, message);
    const canonicalUserId = await getOrCreateCanonicalUser("whatsapp", phone);
    const pref = await notificationPreferences.getNotificationPreference(canonicalUserId);
    assert.equal(pref.preferredChannel, expected);
    assert.match(reply.messages.join("\n"), expectLinkingPrompt);
  });
}

test('"Where are you sending my notifications?" reports the current preference', async () => {
  const phone = freshPhone();
  const unset = await handleIncomingMessage(phone, "Where are you sending my notifications?");
  assert.match(unset.messages.join("\n"), /haven't set a preferred/i);

  await handleIncomingMessage(phone, "notify me on telegram");
  const status = await handleIncomingMessage(phone, "Where are you sending my notifications?");
  assert.match(status.messages.join("\n"), /Telegram/);
});

test("setting a preference for a channel the contact is CURRENTLY chatting on takes effect immediately, no linking needed", async () => {
  const phone = freshPhone(); // a WhatsApp identity
  const reply = await handleIncomingMessage(phone, "use whatsapp for alerts");
  assert.match(reply.messages.join("\n"), /from now on/i);
  assert.doesNotMatch(reply.messages.join("\n"), /link/i);
});

test("setting a preference for an UNLINKED phone-based channel (SMS) asks for a phone number, then links it", async () => {
  const phone = freshPhone(); // a WhatsApp identity, no SMS identity linked yet
  const asked = await handleIncomingMessage(phone, "send my matches by sms");
  assert.match(asked.messages.join("\n"), /phone number/i);
  assert.equal(asked.state.pendingChannelLink, "sms");

  const linked = await handleIncomingMessage(phone, "15559990000");
  assert.match(linked.messages.join("\n"), /linked/i);
  assert.equal(linked.state.pendingChannelLink, undefined);

  const canonicalUserId = await getOrCreateCanonicalUser("whatsapp", phone);
  const identities = await notificationPreferences.getLinkedIdentities(canonicalUserId);
  assert.ok(identities.some((i) => i.platform === "sms" && i.identity === "sms:+15559990000"));
});

test("a malformed reply to the phone-number question keeps waiting instead of giving up", async () => {
  const phone = freshPhone();
  await handleIncomingMessage(phone, "send my matches by sms");
  const badReply = await handleIncomingMessage(phone, "not a number");
  assert.match(badReply.messages.join("\n"), /doesn't look like a phone number/i);
  assert.equal(badReply.state.pendingChannelLink, "sms");

  const goodReply = await handleIncomingMessage(phone, "15551234567");
  assert.match(goodReply.messages.join("\n"), /linked/i);
});

test('"cancel" while waiting for a phone number clears the pending link', async () => {
  const phone = freshPhone();
  await handleIncomingMessage(phone, "send my matches by sms");
  const cancelled = await handleIncomingMessage(phone, "cancel");
  assert.equal(cancelled.state.pendingChannelLink, undefined);
});

test("setting a preference for Telegram (unlinked) issues a one-time code instead of asking for a number", async () => {
  const phone = freshPhone(); // a WhatsApp identity
  const asked = await handleIncomingMessage(phone, "notify me on telegram");
  const codeMatch = asked.messages.join("\n").match(/link\s+([0-9A-F]{8})/i);
  assert.ok(codeMatch, "expected a link code in the reply");
  assert.equal(asked.state.pendingChannelLink, undefined, "Telegram uses the code flow, not the phone-number one");

  const telegramPhone = "telegram:778899";
  resetState(telegramPhone);
  const linked = await handleIncomingMessage(telegramPhone, `link ${codeMatch![1]}`);
  assert.match(linked.messages.join("\n"), /linked/i);

  const canonicalUserId = await getOrCreateCanonicalUser("whatsapp", phone);
  const identities = await notificationPreferences.getLinkedIdentities(canonicalUserId);
  assert.ok(identities.some((i) => i.platform === "telegram" && i.identity === telegramPhone), "the Telegram identity that sent the code is now linked to the SAME canonical user, not a fresh one");
});

test("a link code never attaches to whichever identity happens to send it if it's already its own separate canonical user", async () => {
  const phoneA = freshPhone();
  await handleIncomingMessage(phoneA, "notify me on telegram");

  const telegramPhone = "telegram:990011";
  resetState(telegramPhone);
  // This Telegram identity already has its own canonical user (a prior, unrelated message).
  await handleIncomingMessage(telegramPhone, "status");
  const canonicalUserId = await getOrCreateCanonicalUser("whatsapp", phoneA);
  const code = await notificationPreferences.createPendingIdentityLink(canonicalUserId, "telegram");

  const reply = await handleIncomingMessage(telegramPhone, `link ${code}`);
  assert.match(reply.messages.join("\n"), /already linked to a different Fi account/i);
});

test("an expired or unknown link code is rejected with a clear message", async () => {
  const telegramPhone = "telegram:112233";
  resetState(telegramPhone);
  const reply = await handleIncomingMessage(telegramPhone, "link DEADBEEF");
  assert.match(reply.messages.join("\n"), /don't recognize that code/i);
});

test('a first successful WTB listing nudges for a notification-channel preference exactly once', async () => {
  const phone = freshPhone();
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "wtb rolex under 25k, pre-owned, usa");
  const confirmed = await handleIncomingMessage(phone, "confirm");
  assert.match(confirmed.messages.join("\n"), /how would you like me to notify you/i);

  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "wtb patek 5711 under 80k, pre-owned, usa");
  const confirmedAgain = await handleIncomingMessage(phone, "confirm");
  assert.doesNotMatch(confirmedAgain.messages.join("\n"), /how would you like me to notify you/i, "never nags a second time");
});

test("the nudge is skipped entirely once a preference is already set", async () => {
  const phone = freshPhone();
  await handleIncomingMessage(phone, "use whatsapp for alerts");
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "wtb rolex under 25k, pre-owned, usa");
  const confirmed = await handleIncomingMessage(phone, "confirm");
  assert.doesNotMatch(confirmed.messages.join("\n"), /how would you like me to notify you/i);
});
