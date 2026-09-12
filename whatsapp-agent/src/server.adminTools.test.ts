import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import type { AddressInfo } from "net";
import type { Server } from "http";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test-admin-tools-token";
process.env.WHAPI_TOKEN = "";
process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:5432/luxfi_test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminStore = require("./admin/store") as typeof import("./admin/store");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminSession = require("./admin/session") as typeof import("./admin/session");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createServer } = require("./server") as typeof import("./server");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("./postings/db") as typeof import("./postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rates = require("./fx/rates") as typeof import("./fx/rates");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stateStore = require("./conversation/stateStore") as typeof import("./conversation/stateStore");

const database = new Pool({ connectionString: process.env.DATABASE_URL });
const app = createServer();
let httpServer: Server;
let baseUrl = "";

/** Real administrator-session cookie, bypassing the HTTP login round-trip — same session
 *  format createAdministratorSession/readAdministratorSession use in production. */
function cookieFor(administratorId: number): string {
  return `${adminSession.SESSION_COOKIE_NAME}=${adminSession.createAdministratorSession(administratorId)}`;
}

async function seedAdmin(role: "owner" | "administrator" | "support" | "read_only"): Promise<number> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const row = await database.query(
    "INSERT INTO administrators(name,username,email,password_hash,role,status) VALUES($1,$2,$3,$4,$5,'active') RETURNING id",
    [`Test ${role}`, `test-${role}-${unique}`, `${role}-${unique}@example.com`, await bcrypt.hash("irrelevant-password-1234", 4), role]
  );
  return Number(row.rows[0].id);
}

async function csrfFor(cookie: string): Promise<string> {
  const res = await fetch(`${baseUrl}/admin/api/session`, { headers: { Cookie: cookie } });
  const body = (await res.json()) as { csrfToken: string };
  return body.csrfToken;
}

before(async () => {
  await adminStore.initAdminSchema();
  await database.query("DELETE FROM admin_audit_log");
  await database.query("DELETE FROM admin_login_attempts");
  await database.query("DELETE FROM administrators");
  await postingsDb._resetDbForTests();
  await inventoryDb._resetDbForTests();
  rates._setRatesForTests({ base: "USD", rates: { USD: 1, HKD: 8 }, fetchedAt: new Date() });
  await new Promise<void>((resolve) => { httpServer = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await postingsDb._resetDbForTests();
});
after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  rates._resetRatesForTests();
  await postingsDb._closePoolForTests();
  await inventoryDb._closePoolForTests();
  await adminStore._closePoolForTests();
  await database.end();
});

test("GET /admin/tools requires a signed-in session", async () => {
  const res = await fetch(`${baseUrl}/admin/tools`);
  assert.equal(res.status, 401);
});

test("GET /admin/tools renders for a signed-in administrator and links from the other panel pages", async () => {
  const ownerId = await seedAdmin("owner");
  const res = await fetch(`${baseUrl}/admin/tools`, { headers: { Cookie: cookieFor(ownerId) } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Market Guide debug/);
  assert.match(html, /Inventory search/);
  assert.match(html, /Full account reset/);
  assert.match(html, /Duplicate postings/);

  const dashboard = await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookieFor(ownerId) } });
  assert.match(await dashboard.text(), /href="\/admin\/tools"/, "the dashboard nav must link to the new Tools page");
});

test("GET /admin/api/tools/market-guide-debug returns the raw comparable rows for any signed-in role", async () => {
  const readOnlyId = await seedAdmin("read_only");
  await postingsDb.withSchema((pool) =>
    pool.query(
      `INSERT INTO postings (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,price,currency,status,expires_at)
       VALUES ('whatsapp','chat','g1','panel-mg-1',NULL,'FS','fixture','116500LN',192000,'HKD','active',now()+interval '1 day')`
    )
  );
  const res = await fetch(`${baseUrl}/admin/api/tools/market-guide-debug?reference=116500LN`, { headers: { Cookie: cookieFor(readOnlyId) } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; canonicalReference: string; rows: { rawCurrency: string; amountUsd: number }[] };
  assert.equal(body.ok, true);
  assert.equal(body.canonicalReference, "116500LN");
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].rawCurrency, "HKD");
  assert.equal(body.rows[0].amountUsd, 24000);
});

test("GET /admin/api/tools/inventory-search requires a reference-search term and returns matching WatchFacts rows", async () => {
  const supportId = await seedAdmin("support");
  await inventoryDb.upsertListings(
    [{ id: "panel-inv-1", type: "FS", category: "watches", item: "Rolex Daytona 116500LN", brand: "Rolex", ref: "116500LN", condition: "", price: "24000", location: "", contactName: "x", contactPhone: "1", rating: "", description: "" }],
    new Date().toISOString()
  );
  const missing = await fetch(`${baseUrl}/admin/api/tools/inventory-search`, { headers: { Cookie: cookieFor(supportId) } });
  assert.equal(missing.status, 400);

  const res = await fetch(`${baseUrl}/admin/api/tools/inventory-search?q=116500LN`, { headers: { Cookie: cookieFor(supportId) } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; results: { ref: string }[] };
  assert.equal(body.ok, true);
  assert.ok(body.results.some((r) => r.ref === "116500LN"));
});

test("POST /admin/api/tools/user-reset requires CSRF and blocks read_only and support roles, but allows administrator/owner", async () => {
  const identity = "15550004001";
  await require("./postings/postingsStore").createDirectPosting({ phone: identity, type: "WTB", description: "reset-test", brand: "rolex", reference: null, price: 25000 });

  const administratorId = await seedAdmin("administrator");
  const administratorCookie = cookieFor(administratorId);
  const noCsrf = await fetch(`${baseUrl}/admin/api/tools/user-reset`, { method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" }, body: JSON.stringify({ identity }) });
  assert.equal(noCsrf.status, 419, "modify actions require the CSRF header even before the role check runs");

  const readOnlyId = await seedAdmin("read_only");
  const readOnlyCookie = cookieFor(readOnlyId);
  const readOnlyCsrf = await csrfFor(readOnlyCookie);
  const readOnlyBlocked = await fetch(`${baseUrl}/admin/api/tools/user-reset`, { method: "POST", headers: { Cookie: readOnlyCookie, "Content-Type": "application/json", "X-CSRF-Token": readOnlyCsrf }, body: JSON.stringify({ identity }) });
  assert.equal(readOnlyBlocked.status, 403, "read_only is blocked by the shared modify-action gate");

  const supportId = await seedAdmin("support");
  const supportCookie = cookieFor(supportId);
  const supportCsrf = await csrfFor(supportCookie);
  const supportBlocked = await fetch(`${baseUrl}/admin/api/tools/user-reset`, { method: "POST", headers: { Cookie: supportCookie, "Content-Type": "application/json", "X-CSRF-Token": supportCsrf }, body: JSON.stringify({ identity }) });
  assert.equal(supportBlocked.status, 403, "the reset action additionally blocks support, unlike ordinary modify actions");

  const administratorCsrf = await csrfFor(administratorCookie);
  const administratorOk = await fetch(`${baseUrl}/admin/api/tools/user-reset`, { method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json", "X-CSRF-Token": administratorCsrf }, body: JSON.stringify({ identity }) });
  assert.equal(administratorOk.status, 200, "administrator role is allowed, not just owner");

  const identity2 = "15550004002";
  await require("./postings/postingsStore").createDirectPosting({ phone: identity2, type: "WTB", description: "reset-test-2", brand: "rolex", reference: null, price: 25000 });
  const ownerId = await seedAdmin("owner");
  const ownerCookie = cookieFor(ownerId);
  const ownerCsrf = await csrfFor(ownerCookie);
  const ok = await fetch(`${baseUrl}/admin/api/tools/user-reset`, { method: "POST", headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-CSRF-Token": ownerCsrf }, body: JSON.stringify({ identity: identity2 }) });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { ok: boolean; closedPostings: { id: number }[] };
  assert.equal(body.ok, true);
  assert.equal(body.closedPostings.length, 1);
});

test("POST /admin/api/tools/block-number requires CSRF and blocks read_only and support roles, but allows administrator/owner", async () => {
  const identity = "15550004003";
  const administratorId = await seedAdmin("administrator");
  const administratorCookie = cookieFor(administratorId);
  const noCsrf = await fetch(`${baseUrl}/admin/api/tools/block-number`, { method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json" }, body: JSON.stringify({ identity }) });
  assert.equal(noCsrf.status, 419, "modify actions require the CSRF header even before the role check runs");

  const readOnlyId = await seedAdmin("read_only");
  const readOnlyCookie = cookieFor(readOnlyId);
  const readOnlyCsrf = await csrfFor(readOnlyCookie);
  const readOnlyBlocked = await fetch(`${baseUrl}/admin/api/tools/block-number`, { method: "POST", headers: { Cookie: readOnlyCookie, "Content-Type": "application/json", "X-CSRF-Token": readOnlyCsrf }, body: JSON.stringify({ identity }) });
  assert.equal(readOnlyBlocked.status, 403, "read_only is blocked by the shared modify-action gate");

  const supportId = await seedAdmin("support");
  const supportCookie = cookieFor(supportId);
  const supportCsrf = await csrfFor(supportCookie);
  const supportBlocked = await fetch(`${baseUrl}/admin/api/tools/block-number`, { method: "POST", headers: { Cookie: supportCookie, "Content-Type": "application/json", "X-CSRF-Token": supportCsrf }, body: JSON.stringify({ identity }) });
  assert.equal(supportBlocked.status, 403, "the block action additionally blocks support, unlike ordinary modify actions");

  const administratorCsrf = await csrfFor(administratorCookie);
  const administratorOk = await fetch(`${baseUrl}/admin/api/tools/block-number`, { method: "POST", headers: { Cookie: administratorCookie, "Content-Type": "application/json", "X-CSRF-Token": administratorCsrf }, body: JSON.stringify({ identity }) });
  assert.equal(administratorOk.status, 200, "administrator role is allowed, not just owner");
  const body = (await administratorOk.json()) as { ok: boolean; identitiesBlocked: string[] };
  assert.equal(body.ok, true);
  assert.deepEqual(body.identitiesBlocked, [identity]);
  assert.equal(stateStore.getState(identity).stage, "opted_out", "the identity's own conversation state is actually set opted_out");
});

test("required: blocking sets every identity linked to the given one opted_out, and unblocking restores them to new", async () => {
  const primary = "15550004004";
  const linked = "telegram:15550004004";
  const identityModule = require("./postings/identity") as typeof import("./postings/identity");
  const notificationPreferences = require("./postings/notificationPreferences") as typeof import("./postings/notificationPreferences");
  const canonicalUserId = await identityModule.getOrCreateCanonicalUser("whatsapp", primary);
  await notificationPreferences.linkIdentity(canonicalUserId, "telegram", linked);

  const ownerId = await seedAdmin("owner");
  const ownerCookie = cookieFor(ownerId);
  const ownerCsrf = await csrfFor(ownerCookie);

  const blocked = await fetch(`${baseUrl}/admin/api/tools/block-number`, { method: "POST", headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-CSRF-Token": ownerCsrf }, body: JSON.stringify({ identity: primary }) });
  assert.equal(blocked.status, 200);
  const blockedBody = (await blocked.json()) as { identitiesBlocked: string[] };
  assert.deepEqual(new Set(blockedBody.identitiesBlocked), new Set([primary, linked]));
  assert.equal(stateStore.getState(primary).stage, "opted_out");
  assert.equal(stateStore.getState(linked).stage, "opted_out", "the LINKED identity is opted out too, not just the one given");

  const unblocked = await fetch(`${baseUrl}/admin/api/tools/unblock-number`, { method: "POST", headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-CSRF-Token": ownerCsrf }, body: JSON.stringify({ identity: primary }) });
  assert.equal(unblocked.status, 200);
  assert.equal(stateStore.getState(primary).stage, "new");
  assert.equal(stateStore.getState(linked).stage, "new", "unblocking restores the linked identity too");
});

test("GET /admin/api/tools/duplicate-postings previews duplicate direct postings without closing anything", async () => {
  const readOnlyId = await seedAdmin("read_only");
  const store = require("./postings/postingsStore") as typeof import("./postings/postingsStore");
  const kept = await store.createDirectPosting({ phone: "15550004010", type: "WTB", description: "dup-preview", brand: "Rolex", model: "Daytona", reference: null, price: 30000 });
  await postingsDb.withSchema((pool) =>
    pool.query(
      `INSERT INTO postings (source_platform, source_type, canonical_user_id, source_identity, type, original_text,
         brand, model, reference, condition, price, currency, location, contact_name, contact_phone, status, expires_at, updated_at)
       VALUES ('whatsapp','direct',$1,$2,'WTB','dup','Rolex','Daytona','','',30000,'USD','','',$2,'active', now() + interval '1 day', now() - interval '1 hour')`,
      [kept.canonical_user_id, "15550004010"]
    )
  );

  const res = await fetch(`${baseUrl}/admin/api/tools/duplicate-postings`, { headers: { Cookie: cookieFor(readOnlyId) } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; groups: { keptId: number; closedIds: number[] }[]; postingsClosable: number };
  assert.equal(body.ok, true);
  assert.equal(body.postingsClosable, 1);
  assert.equal(body.groups.length, 1);
  assert.equal(body.groups[0].keptId, kept.id);

  assert.equal((await store.getPosting(kept.id))!.status, "active", "preview must never close anything");
});

test("POST /admin/api/tools/duplicate-postings/close requires confirmed:true and blocks the support role", async () => {
  const store = require("./postings/postingsStore") as typeof import("./postings/postingsStore");
  const kept = await store.createDirectPosting({ phone: "15550004011", type: "WTB", description: "dup-close", brand: "Rolex", model: "Daytona", reference: null, price: 30000 });
  const dup = await postingsDb.withSchema((pool) =>
    pool.query(
      `INSERT INTO postings (source_platform, source_type, canonical_user_id, source_identity, type, original_text,
         brand, model, reference, condition, price, currency, location, contact_name, contact_phone, status, expires_at, updated_at)
       VALUES ('whatsapp','direct',$1,$2,'WTB','dup','Rolex','Daytona','','',30000,'USD','','',$2,'active', now() + interval '1 day', now() - interval '1 hour')
       RETURNING id`,
      [kept.canonical_user_id, "15550004011"]
    )
  );
  const dupId = dup.rows[0].id;

  const supportId = await seedAdmin("support");
  const supportCookie = cookieFor(supportId);
  const supportCsrf = await csrfFor(supportCookie);
  const supportBlocked = await fetch(`${baseUrl}/admin/api/tools/duplicate-postings/close`, { method: "POST", headers: { Cookie: supportCookie, "Content-Type": "application/json", "X-CSRF-Token": supportCsrf }, body: JSON.stringify({ confirmed: true }) });
  assert.equal(supportBlocked.status, 403, "closing duplicates requires administrator or owner role");

  const ownerId = await seedAdmin("owner");
  const ownerCookie = cookieFor(ownerId);
  const ownerCsrf = await csrfFor(ownerCookie);
  const unconfirmed = await fetch(`${baseUrl}/admin/api/tools/duplicate-postings/close`, { method: "POST", headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-CSRF-Token": ownerCsrf }, body: JSON.stringify({}) });
  assert.equal(unconfirmed.status, 400, "confirmed:true is required, even for an owner");
  assert.equal((await store.getPosting(dupId))!.status, "active", "an unconfirmed request must never close anything");

  const confirmed = await fetch(`${baseUrl}/admin/api/tools/duplicate-postings/close`, { method: "POST", headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-CSRF-Token": ownerCsrf }, body: JSON.stringify({ confirmed: true }) });
  assert.equal(confirmed.status, 200);
  const body = (await confirmed.json()) as { ok: boolean; groupsClosed: number; postingsClosed: number };
  assert.equal(body.ok, true);
  assert.equal(body.groupsClosed, 1);
  assert.equal(body.postingsClosed, 1);
  assert.equal((await store.getPosting(dupId))!.status, "admin_closed");
  assert.equal((await store.getPosting(kept.id))!.status, "active", "the kept posting in the group must remain active");
});

test("GET /admin/api/tools/entitlement returns the account's plan/override state for any signed-in role", async () => {
  const readOnlyId = await seedAdmin("read_only");
  const res = await fetch(`${baseUrl}/admin/api/tools/entitlement?phone=15550005001`, { headers: { Cookie: cookieFor(readOnlyId) } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; entitlement: { phone: string; plan: string | null; manualOverrideEnabled: boolean } };
  assert.equal(body.ok, true);
  assert.equal(body.entitlement.phone, "15550005001");
  assert.equal(body.entitlement.plan, null);
  assert.equal(body.entitlement.manualOverrideEnabled, false);
});

test("POST /admin/api/tools/entitlement/override grants and revokes the unlimited override, blocked for support", async () => {
  const phone = "15550005002";
  const supportId = await seedAdmin("support");
  const supportCookie = cookieFor(supportId);
  const supportCsrf = await csrfFor(supportCookie);
  const blocked = await fetch(`${baseUrl}/admin/api/tools/entitlement/override`, { method: "POST", headers: { Cookie: supportCookie, "Content-Type": "application/json", "X-CSRF-Token": supportCsrf }, body: JSON.stringify({ phone, enabled: true }) });
  assert.equal(blocked.status, 403);

  const ownerId = await seedAdmin("owner");
  const ownerCookie = cookieFor(ownerId);
  const ownerCsrf = await csrfFor(ownerCookie);
  const granted = await fetch(`${baseUrl}/admin/api/tools/entitlement/override`, { method: "POST", headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-CSRF-Token": ownerCsrf }, body: JSON.stringify({ phone, enabled: true }) });
  assert.equal(granted.status, 200);
  assert.equal((await granted.json()).entitlement.manualOverrideEnabled, true);

  const revoked = await fetch(`${baseUrl}/admin/api/tools/entitlement/override`, { method: "POST", headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-CSRF-Token": ownerCsrf }, body: JSON.stringify({ phone, enabled: false }) });
  assert.equal((await revoked.json()).entitlement.manualOverrideEnabled, false);
});

test("POST /admin/api/tools/entitlement/plan assigns and clears a plan, rejects an invalid plan key", async () => {
  const phone = "15550005003";
  const ownerId = await seedAdmin("owner");
  const ownerCookie = cookieFor(ownerId);
  const ownerCsrf = await csrfFor(ownerCookie);

  const assigned = await fetch(`${baseUrl}/admin/api/tools/entitlement/plan`, { method: "POST", headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-CSRF-Token": ownerCsrf }, body: JSON.stringify({ phone, plan: "tier2" }) });
  assert.equal(assigned.status, 200);
  assert.equal((await assigned.json()).entitlement.plan, "tier2");

  const invalid = await fetch(`${baseUrl}/admin/api/tools/entitlement/plan`, { method: "POST", headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-CSRF-Token": ownerCsrf }, body: JSON.stringify({ phone, plan: "not-a-real-plan" }) });
  assert.equal(invalid.status, 400);

  const cleared = await fetch(`${baseUrl}/admin/api/tools/entitlement/plan`, { method: "POST", headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-CSRF-Token": ownerCsrf }, body: JSON.stringify({ phone, plan: "none" }) });
  assert.equal((await cleared.json()).entitlement.plan, null);
});

test("GET /admin/api/tools/identities lists every linked identity, unfiltered by search/approval activity", async () => {
  const { getOrCreateCanonicalUser } = require("./postings/identity") as typeof import("./postings/identity");
  await getOrCreateCanonicalUser("whatsapp", "15550006001"); // never searches or approves anything
  await getOrCreateCanonicalUser("telegram", "telegram:5559990002");

  const readOnlyId = await seedAdmin("read_only");
  const res = await fetch(`${baseUrl}/admin/api/tools/identities`, { headers: { Cookie: cookieFor(readOnlyId) } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; rows: { identity: string; platform: string; canonicalUserId: number; firstSeenAt: string }[] };
  assert.equal(body.ok, true);
  // A raw WhatsApp identity is formatted for legibility (real reported ask: unformatted phone
  // numbers throughout the admin panel), but a Telegram identity isn't a phone number at all and
  // must never be reformatted as though it were one.
  const row = body.rows.find((r) => r.identity === "+1 (555) 000-6001");
  assert.ok(row, "an identity with zero searches/approvals must still appear here, unlike the dashboard's Activity by user table");
  assert.equal(row!.platform, "whatsapp");
  assert.ok(row!.firstSeenAt);
  const telegramRow = body.rows.find((r) => r.identity === "telegram:5559990002");
  assert.ok(telegramRow, "a Telegram identity must be left exactly as stored, never reformatted as a phone number");
  assert.equal(telegramRow!.platform, "telegram");
});

test("required: GET /admin/api/tools/open-drafts surfaces a phone's currently open draft, with its phone formatted", async () => {
  const phone = "15550009002";
  stateStore.resetState(phone);
  const state = stateStore.getState(phone);
  state.pendingBuyIntake = { step: "budget", description: "WTB Rolex Daytona", reference: "116500LN", brand: "rolex" };
  stateStore.saveState(state);

  const readOnlyId = await seedAdmin("read_only");
  const res = await fetch(`${baseUrl}/admin/api/tools/open-drafts`, { headers: { Cookie: cookieFor(readOnlyId) } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; rows: { phone: string; type: string; step: string; reference: string | null }[] };
  assert.equal(body.ok, true);
  const row = body.rows.find((r) => r.phone === "+1 (555) 000-9002");
  assert.ok(row, "the open draft must appear, with its phone formatted the same way as the identities table");
  assert.equal(row!.type, "WTB");
  assert.equal(row!.step, "budget");
  assert.equal(row!.reference, "116500LN");

  stateStore.resetState(phone);
  const cleared = await fetch(`${baseUrl}/admin/api/tools/open-drafts`, { headers: { Cookie: cookieFor(readOnlyId) } });
  const clearedBody = (await cleared.json()) as { rows: { phone: string }[] };
  assert.equal(clearedBody.rows.some((r) => r.phone === "+1 (555) 000-9002"), false, "a cleared draft must disappear from the list");
});
