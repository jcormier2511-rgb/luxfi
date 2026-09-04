import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

const { detectDialect, isPostgresUrl, sslOptionsFor, maskValue, openSourceDb } = require("./sourceDb") as typeof import("./sourceDb");

test("dialect is detected from the URL scheme — thecollective_inventory is MySQL on the mysql-production droplet, but a postgres:// URL is still accepted for any other WatchFacts-owned database that genuinely is Postgres", () => {
  assert.equal(detectDialect("mysql://u:p@161.35.0.209:3306/thecollective_inventory"), "mysql");
  assert.equal(detectDialect("postgres://u:p@157.245.84.14:5432/watchfacts"), "postgres");
  assert.equal(detectDialect("postgresql://u:p@host/db"), "postgres");
  assert.equal(detectDialect("mongodb://u:p@host/db"), null);
  assert.equal(isPostgresUrl("postgres://u:p@host/db"), true, "isPostgresUrl is kept for existing call sites");
  assert.equal(isPostgresUrl("mysql://u:p@host/db"), false);
});

test("TLS follows the URL's sslmode: a self-hosted droplet may not speak TLS at all", () => {
  const droplet = "postgres://u:p@157.245.84.14:5432/thecollective_inventory";
  assert.deepEqual(sslOptionsFor(`${droplet}?sslmode=disable`, undefined), false, "sslmode=disable must not be overridden into a TLS attempt");
  assert.deepEqual(sslOptionsFor(`${droplet}?sslmode=require`, undefined), { rejectUnauthorized: false }, "encrypted but unauthenticated without a CA");
  assert.deepEqual(sslOptionsFor(droplet, "-----BEGIN CERTIFICATE-----"), { ca: "-----BEGIN CERTIFICATE-----", rejectUnauthorized: true }, "verified with a CA");
  assert.equal(sslOptionsFor("postgres://u:p@localhost:5432/x", undefined), false);
});

test("sample rows never carry contact details in full", () => {
  assert.equal(maskValue("seller_phone", "+13053897000"), "+1********00");
  assert.equal(maskValue("contact_email", "john@example.com"), "jo************om");
  assert.equal(maskValue("whatsappNumber", "1234"), "***");
  assert.equal(maskValue("price", 34000), 34000, "a non-sensitive column is returned as-is");
  assert.equal(maskValue("title", "x".repeat(200)), `${"x".repeat(120)}… (200 chars)`, "long text is truncated, not dropped");
  assert.equal(maskValue("created_at", new Date("2026-09-01T00:00:00Z")), "2026-09-01T00:00:00.000Z");
});

test("openSourceDb refuses to run with no URL or an unrecognized scheme, before opening a pool", async () => {
  await assert.rejects(() => openSourceDb("", undefined), /WATCHFACTS_DB_URL is not set/);
  await assert.rejects(() => openSourceDb("mongodb://u:p@host/db", undefined), /must be a postgres:\/\/ or mysql:\/\/ URL/);
});

test("openSourceDb accepts a mysql:// URL (pools are lazy — this doesn't connect)", async () => {
  const db = await openSourceDb("mysql://u:p@127.0.0.1:1/db", undefined);
  assert.equal(db.dialect, "mysql");
  await db.close();
});
