import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test-admin-token";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const session = require("./session") as typeof import("./session");

test("isValidAdminToken accepts only the exact configured WEBHOOK_TOKEN", () => {
  assert.equal(session.isValidAdminToken("test-admin-token"), true);
  assert.equal(session.isValidAdminToken("wrong-token"), false);
  assert.equal(session.isValidAdminToken(""), false);
  assert.equal(session.isValidAdminToken("test-admin-token "), false, "must be an exact match, not a prefix");
});

test("createSessionToken produces a token isValidSessionToken accepts", () => {
  const token = session.createSessionToken();
  assert.equal(session.isValidSessionToken(token), true);
});

test("required regression: a tampered session token (payload or signature altered) is rejected", () => {
  const token = session.createSessionToken();
  const [payload, sig] = token.split(".");

  const tamperedPayload = `${Number(payload) + 999999999}.${sig}`;
  assert.equal(session.isValidSessionToken(tamperedPayload), false, "a forged expiry must still fail signature verification");

  const tamperedSig = `${payload}.${sig.slice(0, -1)}${sig.at(-1) === "a" ? "b" : "a"}`;
  assert.equal(session.isValidSessionToken(tamperedSig), false);
});

test("required regression: a token forged with the wrong secret is rejected — a session cookie is only as good as WEBHOOK_TOKEN itself", () => {
  const crypto = require("crypto") as typeof import("crypto");
  const expiresAt = String(Date.now() + 60_000);
  const forgedSig = crypto.createHmac("sha256", "a-different-secret-entirely").update(expiresAt).digest("hex");
  assert.equal(session.isValidSessionToken(`${expiresAt}.${forgedSig}`), false);
});

test("expired session tokens are rejected", () => {
  const now = 1_000_000;
  const token = session.createSessionToken(now);
  const justBeforeExpiry = now + 12 * 60 * 60 * 1000 - 1;
  const justAfterExpiry = now + 12 * 60 * 60 * 1000 + 1;
  assert.equal(session.isValidSessionToken(token, justBeforeExpiry), true);
  assert.equal(session.isValidSessionToken(token, justAfterExpiry), false);
});

test("isValidSessionToken rejects malformed/empty input without throwing", () => {
  assert.equal(session.isValidSessionToken(undefined), false);
  assert.equal(session.isValidSessionToken(null), false);
  assert.equal(session.isValidSessionToken(""), false);
  assert.equal(session.isValidSessionToken("no-dot-here"), false);
  assert.equal(session.isValidSessionToken("not-a-number.deadbeef"), false);
});

test("parseCookies reads a name from a multi-cookie header, trimming whitespace and decoding values", () => {
  const cookies = session.parseCookies("a=1; luxfi_admin_session=abc%2Edef; other=2");
  assert.equal(cookies.luxfi_admin_session, "abc.def");
  assert.equal(cookies.a, "1");
});

test("parseCookies returns an empty object for a missing header", () => {
  assert.deepEqual(session.parseCookies(undefined), {});
  assert.deepEqual(session.parseCookies(null), {});
});

test("session cookie header carries HttpOnly + SameSite=Strict always, and Secure only when the request was https", () => {
  const httpCookie = session.buildSessionCookieHeader("tok123", false);
  assert.match(httpCookie, /HttpOnly/);
  assert.match(httpCookie, /SameSite=Strict/);
  assert.doesNotMatch(httpCookie, /Secure/);

  const httpsCookie = session.buildSessionCookieHeader("tok123", true);
  assert.match(httpsCookie, /Secure/);
});

test("logout cookie header clears the cookie via Max-Age=0", () => {
  const header = session.buildLogoutCookieHeader(false);
  assert.match(header, /Max-Age=0/);
  assert.match(header, new RegExp(`^${session.SESSION_COOKIE_NAME}=;`));
});

test("isHttpsRequest trusts either req.secure or a forwarded-proto https header", () => {
  assert.equal(session.isHttpsRequest({ secure: true, headers: {} }), true);
  assert.equal(session.isHttpsRequest({ secure: false, headers: { "x-forwarded-proto": "https" } }), true);
  assert.equal(session.isHttpsRequest({ secure: false, headers: { "x-forwarded-proto": "http" } }), false);
  assert.equal(session.isHttpsRequest({ headers: {} }), false);
});
