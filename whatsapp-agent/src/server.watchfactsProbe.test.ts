import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "probe-admin-token";
process.env.WHAPI_TOKEN = "";
process.env.WATCHFACTS_EMAIL = "ops@example.com";
process.env.WATCHFACTS_PASSWORD = "wf-secret";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createServer } = require("./server") as typeof import("./server");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isProbableWatchFactsUrl } = require("./watchfacts/probeCatalogue") as typeof import("./watchfacts/probeCatalogue");
// createServer() starts background schema work; close its pools or it outlives the test.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("./postings/db") as typeof import("./postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");

const TOKEN = "probe-admin-token";
let httpServer: Server;
let baseUrl = "";

before(async () => {
  const app = createServer();
  await new Promise<void>((resolve) => { httpServer = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await postingsDb._closePoolForTests();
  await inventoryDb._closePoolForTests();
});

test("the probe is admin-token gated", async () => {
  for (const query of ["", "?token=", "?token=wrong"]) {
    assert.equal((await fetch(`${baseUrl}/admin/watchfacts/probe${query}`)).status, 401, `"${query}"`);
  }
});

/**
 * The allowlist is the security boundary, not the token. An admin endpoint that browses to any
 * URL it is handed is request forgery aimed at whatever the server can reach — a cloud
 * provider's metadata service being the classic target — and an admin token leaking is a much
 * smaller incident than that.
 */
test("only https watchfacts.com URLs can be probed", async () => {
  const blocked = [
    "http://169.254.169.254/latest/meta-data/",           // cloud metadata over plain http
    "https://169.254.169.254/latest/meta-data/",          // ...and over https
    "http://localhost:5432/",                             // this host's own services
    "https://evil.example.com/",
    "https://watchfacts.com.evil.example.com/",           // suffix that only looks like the domain
    "https://notwatchfacts.com/",
    "http://watchfacts.com/",                             // right host, unencrypted
  ];
  for (const url of blocked) {
    assert.equal(isProbableWatchFactsUrl(url), false, `${url} must not be probeable`);
    const res = await fetch(`${baseUrl}/admin/watchfacts/probe?token=${TOKEN}&url=${encodeURIComponent(url)}`);
    assert.equal(res.status, 400, `${url} must be refused`);
    assert.deepEqual((await res.json() as { rejected: string[] }).rejected, [url]);
  }
});

test("the real site and its subdomains are accepted", () => {
  for (const url of ["https://watchfacts.com/", "https://watchfacts.com/marketplace", "https://www.watchfacts.com/x"]) {
    assert.equal(isProbableWatchFactsUrl(url), true, url);
  }
});

test("a deployment with no WatchFacts credentials says so instead of failing obscurely", async () => {
  const saved = process.env.WATCHFACTS_PASSWORD;
  try {
    // config is read once at load, so exercise the same guard through the module's own value.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require("./config") as typeof import("./config");
    const original = config.watchfacts.password;
    (config.watchfacts as { password: string }).password = "";
    const res = await fetch(`${baseUrl}/admin/watchfacts/probe?token=${TOKEN}`);
    assert.equal(res.status, 400);
    assert.match((await res.json() as { error: string }).error, /WATCHFACTS_EMAIL \/ WATCHFACTS_PASSWORD/);
    (config.watchfacts as { password: string }).password = original;
  } finally {
    process.env.WATCHFACTS_PASSWORD = saved;
  }
});
