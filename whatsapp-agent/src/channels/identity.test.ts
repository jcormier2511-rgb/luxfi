import { test } from "node:test";
import assert from "node:assert/strict";
import {
  telegramIdentity,
  smsIdentity,
  platformForIdentity,
  telegramChatIdFromIdentity,
  smsPhoneFromIdentity,
} from "./identity";

test("a raw WhatsApp phone number (no prefix) is identified as whatsapp — backward compat with every existing stored identity", () => {
  assert.equal(platformForIdentity("15551234567"), "whatsapp");
});

test("telegramIdentity prefixes a chat id, and platformForIdentity/telegramChatIdFromIdentity round-trip it", () => {
  const identity = telegramIdentity("998877");
  assert.equal(identity, "telegram:998877");
  assert.equal(platformForIdentity(identity), "telegram");
  assert.equal(telegramChatIdFromIdentity(identity), "998877");
});

test("smsIdentity prefixes a phone number, and platformForIdentity/smsPhoneFromIdentity round-trip it", () => {
  const identity = smsIdentity("+15559998888");
  assert.equal(identity, "sms:+15559998888");
  assert.equal(platformForIdentity(identity), "sms");
  assert.equal(smsPhoneFromIdentity(identity), "+15559998888");
});
