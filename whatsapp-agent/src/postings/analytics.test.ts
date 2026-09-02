import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logSearchRequest, getTopRequests } = require("./analytics") as typeof import("./analytics");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _resetDbForTests, _closePoolForTests, withSchema } = require("./db") as typeof import("./db");

after(() => _closePoolForTests());

test("logSearchRequest persists a row, and getTopRequests counts and ranks by frequency", async () => {
  await _resetDbForTests();
  await logSearchRequest("15551110000", "buy", "Rolex Daytona");
  await logSearchRequest("15552220000", "buy", "rolex daytona"); // same term, different casing
  await logSearchRequest("15553330000", "sell", "Omega Speedmaster");

  const top = await getTopRequests(10, 30);
  assert.equal(top[0].query.toLowerCase(), "rolex daytona");
  assert.equal(top[0].count, 2, "case/whitespace-insensitive grouping must combine both Daytona searches");
  assert.equal(top[1].count, 1);
});

test("getTopRequests only counts requests within the requested day window", async () => {
  await _resetDbForTests();
  await logSearchRequest("15551110000", "buy", "Patek 5711");
  await withSchema((pool) =>
    pool.query(`UPDATE search_requests SET created_at = now() - interval '90 days' WHERE query = 'Patek 5711'`)
  );
  await logSearchRequest("15552220000", "buy", "Patek 5711");

  const top = await getTopRequests(10, 30);
  const entry = top.find((t) => t.query === "Patek 5711");
  assert.equal(entry?.count, 1, "the 90-day-old row must be excluded from a 30-day window");
});

test("logSearchRequest is a silent no-op for an empty/whitespace-only query", async () => {
  await _resetDbForTests();
  await logSearchRequest("15551110000", "buy", "   ");
  const top = await getTopRequests(10, 30);
  assert.equal(top.length, 0);
});
