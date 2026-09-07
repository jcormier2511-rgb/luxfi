import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import type { AddressInfo } from "net";
import type { Server } from "http";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test-push-groups-token";
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
const { getListingLimits } = require("./postings/listingConfig") as typeof import("./postings/listingConfig");

const database = new Pool({ connectionString: process.env.DATABASE_URL });
const app = createServer();
let httpServer: Server;
let baseUrl = "";

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
  await getListingLimits(); // ensures listing_push_groups exists
  await new Promise<void>((resolve) => { httpServer = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
// Push-group settings now live in the unified Group Registry (approved_groups -- see
// postings/listingConfig.ts) rather than the old, now-legacy listing_push_groups table, so
// resetting the latter no longer isolates these tests from each other.
beforeEach(async () => {
  await postingsDb.withSchema((pool) => pool.query("DELETE FROM approved_groups"));
});
after(async () => {
  // approved_groups is not part of the postings reset: leaving rows behind would pollute a
  // later test file's own group-registry expectations (same convention as groupActivity.test.ts).
  await postingsDb.withSchema((pool) => pool.query("DELETE FROM approved_groups"));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await postingsDb._closePoolForTests();
  await adminStore._closePoolForTests();
  await database.end();
});

test("GET /admin/push-groups requires a signed-in session, then renders and links from the other panel pages", async () => {
  const unauth = await fetch(`${baseUrl}/admin/push-groups`);
  assert.equal(unauth.status, 401);

  const ownerId = await seedAdmin("owner");
  const res = await fetch(`${baseUrl}/admin/push-groups`, { headers: { Cookie: cookieFor(ownerId) } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Add push group/);

  const dashboard = await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookieFor(ownerId) } });
  assert.match(await dashboard.text(), /href="\/admin\/push-groups"/, "the dashboard nav must link to the new Push Groups page");
});

test("PUT then GET /admin/api/push-groups round-trips a saved push group, blocked for read_only", async () => {
  const readOnlyId = await seedAdmin("read_only");
  const readOnlyCookie = cookieFor(readOnlyId);
  const readOnlyCsrf = await csrfFor(readOnlyCookie);
  const blocked = await fetch(`${baseUrl}/admin/api/listing-settings/push-groups/wa-group-1`, {
    method: "PUT",
    headers: { Cookie: readOnlyCookie, "Content-Type": "application/json", "X-CSRF-Token": readOnlyCsrf },
    body: JSON.stringify({ group_name: "Miami Dealers", platform: "whatsapp", enabled: true, allow_fs: true, allow_wtb: true, priority: 100 }),
  });
  assert.equal(blocked.status, 403, "read_only is blocked from saving a push group");

  const ownerId = await seedAdmin("owner");
  const ownerCookie = cookieFor(ownerId);
  const ownerCsrf = await csrfFor(ownerCookie);
  const saved = await fetch(`${baseUrl}/admin/api/listing-settings/push-groups/wa-group-1`, {
    method: "PUT",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-CSRF-Token": ownerCsrf },
    body: JSON.stringify({ group_name: "Miami Dealers", platform: "whatsapp", enabled: true, allow_fs: true, allow_wtb: true, priority: 100 }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).group_name, "Miami Dealers");

  const list = await fetch(`${baseUrl}/admin/api/push-groups`, { headers: { Cookie: readOnlyCookie } });
  assert.equal(list.status, 200, "listing push groups is read-only and allowed for read_only");
  const rows = (await list.json()) as { group_id: string; group_name: string }[];
  assert.ok(rows.some((r) => r.group_id === "wa-group-1" && r.group_name === "Miami Dealers"));
});

test("DELETE /admin/api/listing-settings/push-groups/:groupId removes it, blocked for read_only", async () => {
  const ownerId = await seedAdmin("owner");
  const ownerCookie = cookieFor(ownerId);
  const ownerCsrf = await csrfFor(ownerCookie);
  await fetch(`${baseUrl}/admin/api/listing-settings/push-groups/tg-group-1`, {
    method: "PUT",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-CSRF-Token": ownerCsrf },
    body: JSON.stringify({ group_name: "Asia Dealers", platform: "telegram", enabled: true, allow_fs: true, allow_wtb: true, priority: 100 }),
  });

  const readOnlyId = await seedAdmin("read_only");
  const readOnlyCookie = cookieFor(readOnlyId);
  const readOnlyCsrf = await csrfFor(readOnlyCookie);
  const blocked = await fetch(`${baseUrl}/admin/api/listing-settings/push-groups/tg-group-1`, { method: "DELETE", headers: { Cookie: readOnlyCookie, "X-CSRF-Token": readOnlyCsrf } });
  assert.equal(blocked.status, 403);

  const deleted = await fetch(`${baseUrl}/admin/api/listing-settings/push-groups/tg-group-1`, { method: "DELETE", headers: { Cookie: ownerCookie, "X-CSRF-Token": ownerCsrf } });
  assert.equal(deleted.status, 200);

  const list = await fetch(`${baseUrl}/admin/api/push-groups`, { headers: { Cookie: ownerCookie } });
  const rows = (await list.json()) as { group_id: string }[];
  assert.equal(rows.some((r) => r.group_id === "tg-group-1"), false, "the deleted group must no longer be listed");
});

test("GET /admin/api/push-groups/template.csv returns a downloadable CSV sample, no auth required (same as the users template)", async () => {
  const res = await fetch(`${baseUrl}/admin/api/push-groups/template.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/csv/);
  const body = await res.text();
  assert.match(body, /^group_id,group_name,platform,enabled,allow_fs,allow_wtb,priority,notes/);
});

test("POST /admin/api/push-groups/import creates and updates push groups from a CSV upload, blocked for read_only", async () => {
  const readOnlyId = await seedAdmin("read_only");
  const readOnlyCookie = cookieFor(readOnlyId);
  const readOnlyCsrf = await csrfFor(readOnlyCookie);
  const csv = "group_id,group_name,platform,enabled,allow_fs,allow_wtb,priority,notes\ncsv-wa-1,Miami Dealers,whatsapp,true,true,true,100,\ncsv-tg-1,Asia Buyers,telegram,true,true,false,50,FS only";
  const blocked = await fetch(`${baseUrl}/admin/api/push-groups/import`, {
    method: "POST",
    headers: { Cookie: readOnlyCookie, "Content-Type": "text/csv", "X-CSRF-Token": readOnlyCsrf },
    body: csv,
  });
  assert.equal(blocked.status, 403, "read_only is blocked from importing push groups");

  const ownerId = await seedAdmin("owner");
  const ownerCookie = cookieFor(ownerId);
  const ownerCsrf = await csrfFor(ownerCookie);
  const created = await fetch(`${baseUrl}/admin/api/push-groups/import`, {
    method: "POST",
    headers: { Cookie: ownerCookie, "Content-Type": "text/csv", "X-CSRF-Token": ownerCsrf },
    body: csv,
  });
  assert.equal(created.status, 200);
  const createdBody = (await created.json()) as { added: number; updated: number; errors: unknown[] };
  assert.equal(createdBody.added, 2);
  assert.equal(createdBody.updated, 0);
  assert.equal(createdBody.errors.length, 0);

  const list = await fetch(`${baseUrl}/admin/api/push-groups`, { headers: { Cookie: ownerCookie } });
  const rows = (await list.json()) as { group_id: string; group_name: string; platform: string; allow_wtb: boolean }[];
  const tgRow = rows.find((r) => r.group_id === "csv-tg-1");
  assert.equal(tgRow?.group_name, "Asia Buyers");
  assert.equal(tgRow?.platform, "telegram");
  assert.equal(tgRow?.allow_wtb, false);

  // Re-uploading the same CSV with a changed name must update in place, not duplicate.
  const reupload = await fetch(`${baseUrl}/admin/api/push-groups/import`, {
    method: "POST",
    headers: { Cookie: ownerCookie, "Content-Type": "text/csv", "X-CSRF-Token": ownerCsrf },
    body: "group_id,group_name,platform,enabled,allow_fs,allow_wtb,priority,notes\ncsv-wa-1,Miami Dealers Renamed,whatsapp,true,true,true,100,",
  });
  const reuploadBody = (await reupload.json()) as { added: number; updated: number };
  assert.equal(reuploadBody.added, 0);
  assert.equal(reuploadBody.updated, 1);
  const list2 = await fetch(`${baseUrl}/admin/api/push-groups`, { headers: { Cookie: ownerCookie } });
  const rows2 = (await list2.json()) as { group_id: string; group_name: string }[];
  assert.equal(rows2.filter((r) => r.group_id === "csv-wa-1").length, 1, "no duplicate row for a re-uploaded group_id");
  assert.equal(rows2.find((r) => r.group_id === "csv-wa-1")?.group_name, "Miami Dealers Renamed");
});

test("POST /admin/api/push-groups/import reports a per-row error for a missing group_id without failing the whole batch", async () => {
  const ownerId = await seedAdmin("owner");
  const ownerCookie = cookieFor(ownerId);
  const ownerCsrf = await csrfFor(ownerCookie);
  const csv = "group_id,group_name,platform,enabled,allow_fs,allow_wtb,priority,notes\n,Missing Id,whatsapp,true,true,true,100,\ncsv-valid-1,Valid Row,whatsapp,true,true,true,100,";
  const res = await fetch(`${baseUrl}/admin/api/push-groups/import`, {
    method: "POST",
    headers: { Cookie: ownerCookie, "Content-Type": "text/csv", "X-CSRF-Token": ownerCsrf },
    body: csv,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { added: number; errors: { row: number; error: string }[] };
  assert.equal(body.added, 1, "the valid row must still be imported");
  assert.equal(body.errors.length, 1);
  assert.equal(body.errors[0].row, 2);
});

test("GET /admin/api/push-groups/export.csv returns the currently configured push groups as CSV", async () => {
  const ownerId = await seedAdmin("owner");
  const ownerCookie = cookieFor(ownerId);
  const ownerCsrf = await csrfFor(ownerCookie);
  await fetch(`${baseUrl}/admin/api/listing-settings/push-groups/export-group-1`, {
    method: "PUT",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-CSRF-Token": ownerCsrf },
    body: JSON.stringify({ group_name: "Export Test Group", platform: "whatsapp", enabled: true, allow_fs: true, allow_wtb: true, priority: 100 }),
  });

  const res = await fetch(`${baseUrl}/admin/api/push-groups/export.csv`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/csv/);
  const body = await res.text();
  assert.match(body, /export-group-1,Export Test Group,whatsapp,true,true,true,100/);
});
