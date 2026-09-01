import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-admin-panel-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test-admin-secret-token-xyz";
process.env.WHAPI_TOKEN = "";
process.env.ENABLE_AI_MATCHING = "true";
process.env.AI_MATCHING_TEST_PHONE = "15550001111";
process.env.ANTHROPIC_API_KEY = "sk-ant-secret-should-never-render-1234";
process.env.OPENAI_API_KEY = "sk-openai-secret-should-never-render-5678";
process.env.WATCHFACTS_EMAIL = "ops@example.com";
process.env.WATCHFACTS_PASSWORD = "wf-secret-should-never-render-9012";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require("./config") as typeof import("./config");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createServer } = require("./server") as typeof import("./server");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("./postings/db") as typeof import("./postings/db");

const app = createServer();
let httpServer: Server;
let baseUrl = "";

before(async () => {
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await new Promise<void>((resolve) => {
    httpServer = app.listen(0, () => resolve());
  });
  const address = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

function extractCookie(res: Response): string {
  const raw = res.headers.get("set-cookie");
  assert.ok(raw, "expected a Set-Cookie header");
  return raw!.split(";")[0]; // "name=value" only
}

async function loginCookie(): Promise<string> {
  const res = await fetch(`${baseUrl}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: config.server.webhookToken }).toString(),
  });
  return extractCookie(res);
}

test("GET /admin without a session shows the login form, not the dashboard, and never leaks the token", async () => {
  const res = await fetch(`${baseUrl}/admin`);
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.match(html, /Sign in/);
  assert.match(html, /action="\/admin\/login"/);
  assert.doesNotMatch(html, /Whapi connectivity/, "must not render dashboard content while unauthenticated");
  assert.equal(html.includes(config.server.webhookToken), false);
});

test("required regression: GET /admin ignores a token passed as a query string — the panel must never accept the token via URL", async () => {
  const res = await fetch(`${baseUrl}/admin?token=${encodeURIComponent(config.server.webhookToken)}`);
  assert.equal(res.status, 401, "a token in the query string must never be an alternate way in");
});

test("POST /admin/login with the wrong token is rejected, sets no session cookie, and never echoes the submitted value", async () => {
  const res = await fetch(`${baseUrl}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: "totally-wrong" }).toString(),
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
  const html = await res.text();
  assert.match(html, /Invalid token/);
  assert.doesNotMatch(html, /totally-wrong/);
});

test("POST /admin/login with the correct token sets an HttpOnly, SameSite=Strict session cookie (never the raw token) and redirects to /admin", async () => {
  const res = await fetch(`${baseUrl}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: config.server.webhookToken }).toString(),
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/admin");
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie);
  assert.match(setCookie!, /HttpOnly/);
  assert.match(setCookie!, /SameSite=Strict/);
  assert.equal(setCookie!.includes(config.server.webhookToken), false, "the cookie must carry a signed session value, never the raw token");
});

test("GET /admin with a valid session renders read-only status for every required section, and never leaks a secret", async () => {
  const cookie = await loginCookie();
  const res = await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();

  for (const heading of [
    "Whapi connectivity",
    "PostgreSQL / schema",
    "Membership",
    "Payments",
    "Top requests",
    "Market updates",
    "V4 postings",
    "WatchFacts FS / WTB sync",
    "AI matching",
    "Deployment health",
    "Contacts CSV upload",
    "Activity by user",
  ]) {
    assert.ok(html.includes(heading), `dashboard is missing required section: ${heading}`);
  }

  // The whole point of a "no secrets, ever" admin panel — checked against the actual configured
  // values for every category the task calls out, not just a couple of examples.
  assert.equal(html.includes(config.server.webhookToken), false, "WEBHOOK_TOKEN must never render");
  assert.equal(html.includes(process.env.ANTHROPIC_API_KEY!), false, "the Anthropic API key must never render");
  assert.equal(html.includes(process.env.OPENAI_API_KEY!), false, "the OpenAI API key must never render");
  assert.equal(html.includes(process.env.WATCHFACTS_PASSWORD!), false, "the WatchFacts password must never render");
  assert.equal(html.includes(config.database.url), false, "the full DB connection string (which embeds a password) must never render");
  assert.equal(html.includes("postgres:postgres@"), false, "the DB credential pair specifically must never render");
});

test("GET /admin with a tampered session cookie is treated as logged out", async () => {
  const cookie = await loginCookie();
  const tampered = cookie.replace(/\.[0-9a-f]+$/, ".deadbeef");
  const res = await fetch(`${baseUrl}/admin`, { headers: { Cookie: tampered } });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /Sign in/);
});

test("GET /admin/logout clears the session — a subsequent request without a fresh login shows the login form again", async () => {
  const cookie = await loginCookie();
  const confirmLoggedIn = await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookie } });
  assert.equal(confirmLoggedIn.status, 200);

  const logoutRes = await fetch(`${baseUrl}/admin/logout`, { headers: { Cookie: cookie }, redirect: "manual" });
  assert.equal(logoutRes.status, 303);
  const clearedCookie = logoutRes.headers.get("set-cookie");
  assert.ok(clearedCookie);
  assert.match(clearedCookie!, /Max-Age=0/);

  const afterLogout = await fetch(`${baseUrl}/admin`, { headers: { Cookie: clearedCookie!.split(";")[0] } });
  assert.equal(afterLogout.status, 401);
});

test("POST /admin/panel/upload-contacts requires a session and, once authenticated, replaces and reloads contacts.csv", async () => {
  const noSession = await fetch(`${baseUrl}/admin/panel/upload-contacts`, {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: "phone,name,tier\n15550009999,Test Dealer,A\n",
  });
  assert.equal(noSession.status, 401);

  const cookie = await loginCookie();
  const csv = "phone,name,tier\n15550009999,Test Dealer,A\n15550008888,Another,B\n";
  const uploadRes = await fetch(`${baseUrl}/admin/panel/upload-contacts`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "text/csv" },
    body: csv,
  });
  assert.equal(uploadRes.status, 200);
  const body = (await uploadRes.json()) as { ok: boolean; contacts: number };
  assert.equal(body.ok, true);
  assert.equal(body.contacts, 2);
  assert.equal(fs.readFileSync(config.data.contactsCsv, "utf-8"), csv);
});
