import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";

process.env.WEBHOOK_TOKEN = "panel-test-token";
process.env.WHAPI_TOKEN = "whapi-panel-secret";
process.env.OPENAI_API_KEY = "openai-panel-secret";
process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:5432/luxfi_test";

const { createServer } = require("./server") as typeof import("./server");

let server: ReturnType<ReturnType<typeof createServer>["listen"]>;
let baseUrl: string;

before(() => new Promise<void>((resolve) => {
  server = createServer().listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    resolve();
  });
}));

after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test("GET /admin renders a password login without exposing the configured token", async () => {
  const response = await fetch(`${baseUrl}/admin`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /WEBHOOK_TOKEN/);
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /panel-test-token/);
});

test("admin login rejects an invalid token", async () => {
  const response = await fetch(`${baseUrl}/admin/login`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=wrong", redirect: "manual",
  });
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /panel-test-token/);
});

test("admin login creates a hardened session and redirects to GET /admin", async () => {
  const response = await fetch(`${baseUrl}/admin/login`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" }, body: "token=panel-test-token", redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/admin");
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /luxfi_admin=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(cookie, /panel-test-token/);

  const dashboard = await fetch(`${baseUrl}/admin`, { headers: { cookie: cookie.split(";")[0] } });
  const html = await dashboard.text();
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get("cache-control"), "no-store");
  assert.match(html, /Morning update/);
  assert.match(html, /Afternoon update/);
  assert.match(html, /Delivery grace/);
  assert.doesNotMatch(html, /panel-test-token|whapi-panel-secret|openai-panel-secret/);
});

test("contact CSV upload does not accept an unauthenticated request", async () => {
  const response = await fetch(`${baseUrl}/admin/upload/contacts`, { method: "POST", headers: { "content-type": "text/csv" }, body: "phone,name,tier\n1,Test,A\n" });
  assert.equal(response.status, 401);
});

test("legacy token authentication works only with the configured non-empty token", async () => {
  assert.equal((await fetch(`${baseUrl}/admin/group-listings`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/admin/group-listings?token=wrong`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/admin/group-listings?token=panel-test-token`)).status, 200);
});
