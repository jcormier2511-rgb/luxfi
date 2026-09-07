import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import type { AddressInfo } from "net";
import type { Server } from "http";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test-group-registry-token";
process.env.WHAPI_TOKEN = "test-whapi-token";
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
const whapiClient = require("./whapi/client") as typeof import("./whapi/client");

const database = new Pool({ connectionString: process.env.DATABASE_URL });
const app = createServer();
let httpServer: Server;
let baseUrl = "";
const actor = null as unknown as import("./admin/store").Administrator;

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
  await new Promise<void>((resolve) => { httpServer = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await postingsDb.withSchema((pool) => pool.query("DELETE FROM approved_groups"));
});
after(async () => {
  await postingsDb.withSchema((pool) => pool.query("DELETE FROM approved_groups"));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await postingsDb._closePoolForTests();
  await adminStore._closePoolForTests();
  await database.end();
});

test("required: DELETE /admin/api/groups/:id without confirm=true is rejected; with it, succeeds", async () => {
  const ownerId = await seedAdmin("owner");
  const ownerCookie = cookieFor(ownerId);
  const ownerCsrf = await csrfFor(ownerCookie);
  const row = await adminStore.saveGroup(actor, { group_name: "Deletable", group_id: "http-delete-1", platform: "whatsapp" });

  const unconfirmed = await fetch(`${baseUrl}/admin/api/groups/${row.id}`, { method: "DELETE", headers: { Cookie: ownerCookie, "X-CSRF-Token": ownerCsrf } });
  assert.equal(unconfirmed.status, 400);
  assert.ok((await adminStore.listGroups()).some((g: any) => g.id === row.id), "must still exist");

  const confirmed = await fetch(`${baseUrl}/admin/api/groups/${row.id}?confirm=true`, { method: "DELETE", headers: { Cookie: ownerCookie, "X-CSRF-Token": ownerCsrf } });
  assert.equal(confirmed.status, 200);
  assert.equal((await adminStore.listGroups()).some((g: any) => g.id === row.id), false);
});

test("required: POST /admin/api/groups/sync-whapi requires a session + CSRF, is blocked for read_only, and runs discovery for an owner", async (t) => {
  t.mock.method(whapiClient, "listWhapiGroups", async () => [{ groupId: "http-sync-1", name: "Synced Group", raw: {} }]);

  const unauth = await fetch(`${baseUrl}/admin/api/groups/sync-whapi`, { method: "POST" });
  assert.equal(unauth.status, 401);

  const readOnlyId = await seedAdmin("read_only");
  const readOnlyCookie = cookieFor(readOnlyId);
  const readOnlyCsrf = await csrfFor(readOnlyCookie);
  const blocked = await fetch(`${baseUrl}/admin/api/groups/sync-whapi`, { method: "POST", headers: { Cookie: readOnlyCookie, "X-CSRF-Token": readOnlyCsrf } });
  assert.equal(blocked.status, 403);

  const ownerId = await seedAdmin("owner");
  const ownerCookie = cookieFor(ownerId);
  const ownerCsrf = await csrfFor(ownerCookie);
  const res = await fetch(`${baseUrl}/admin/api/groups/sync-whapi`, { method: "POST", headers: { Cookie: ownerCookie, "X-CSRF-Token": ownerCsrf } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { discovered: number; created: number };
  assert.equal(body.discovered, 1);
  assert.equal(body.created, 1);
  assert.ok((await adminStore.listGroups()).some((g: any) => g.group_id === "http-sync-1"));
});

test("required: POST /admin/api/groups/bulk requires a session + CSRF, is blocked for read_only, and applies the action for an owner", async () => {
  const a = await adminStore.saveGroup(actor, { group_name: "Bulk A", group_id: "http-bulk-a", platform: "whatsapp" });
  const b = await adminStore.saveGroup(actor, { group_name: "Bulk B", group_id: "http-bulk-b", platform: "whatsapp" });

  const unauth = await fetch(`${baseUrl}/admin/api/groups/bulk`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [a.id], action: "enable_monitoring" }) });
  assert.equal(unauth.status, 401);

  const readOnlyId = await seedAdmin("read_only");
  const readOnlyCookie = cookieFor(readOnlyId);
  const readOnlyCsrf = await csrfFor(readOnlyCookie);
  const blocked = await fetch(`${baseUrl}/admin/api/groups/bulk`, {
    method: "POST",
    headers: { Cookie: readOnlyCookie, "Content-Type": "application/json", "X-CSRF-Token": readOnlyCsrf },
    body: JSON.stringify({ ids: [a.id], action: "enable_monitoring" }),
  });
  assert.equal(blocked.status, 403);

  const ownerId = await seedAdmin("owner");
  const ownerCookie = cookieFor(ownerId);
  const ownerCsrf = await csrfFor(ownerCookie);
  const res = await fetch(`${baseUrl}/admin/api/groups/bulk`, {
    method: "POST",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-CSRF-Token": ownerCsrf },
    body: JSON.stringify({ ids: [a.id, b.id], action: "enable_monitoring" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; updated: number };
  assert.equal(body.updated, 2);
  const rows = await adminStore.listGroups();
  assert.equal(rows.find((r: any) => r.id === a.id).monitoring_enabled, true);
  assert.equal(rows.find((r: any) => r.id === b.id).monitoring_enabled, true);
});
