import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

const { isPostgresUrl, sslOptionsFor, maskValue, openSourceDb } = require("./sourceDb") as typeof import("./sourceDb");

test("only a postgres:// URL is accepted — WatchFacts is Postgres on the wf-postgres-prod droplet, nothing else", () => {
  assert.equal(isPostgresUrl("postgres://u:p@157.245.84.14:5432/thecollective_inventory"), true);
  assert.equal(isPostgresUrl("postgresql://u:p@host/db"), true);
  assert.equal(isPostgresUrl("mysql://u:p@host/db"), false);
  assert.equal(isPostgresUrl("mongodb://u:p@host/db"), false);
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

test("openSourceDb refuses to run with no URL or a non-Postgres URL, before opening a pool", async () => {
  await assert.rejects(() => openSourceDb("", undefined), /WATCHFACTS_DB_URL is not set/);
  await assert.rejects(() => openSourceDb("mysql://u:p@host/db", undefined), /must be a postgres:\/\/ URL/);
});
