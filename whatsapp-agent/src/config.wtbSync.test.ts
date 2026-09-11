import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

/**
 * Real reported bug: a live WatchFacts WTB listing (a genuine want-to-buy post for a reference
 * Market Pulse otherwise had plenty of FS data for) never appeared in Market Pulse at all --
 * not filtered out, never synced in the first place. Root cause: ENABLE_WTB_SYNC defaulted hard
 * off from before syncWtbFromDb existed, back when WTB only had the unreliable/unconfirmed
 * browser-scraping path -- and nothing ever flipped it once the same confirmed, DB-direct path
 * FS already used (see syncInventory.ts's fetchOpenAuctionsFromDb) covered WTB too. The Railway
 * deployment had WATCHFACTS_DB_URL configured (FS synced fine) but never separately set
 * ENABLE_WTB_SYNC=true, so WTB sync silently never ran.
 *
 * config.ts reads process.env once at module load, so each scenario below reloads it fresh via
 * require.cache rather than relying on any single process-wide value.
 */
const configPath = require.resolve("./config");
function loadConfig(env: Record<string, string | undefined>): typeof import("./config") {
  delete require.cache[configPath];
  const prior: Record<string, string | undefined> = {};
  for (const key of ["ENABLE_WTB_SYNC", "WATCHFACTS_DB_URL"]) {
    prior[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("./config") as typeof import("./config");
  } finally {
    for (const key of Object.keys(prior)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

test("required regression: WTB sync auto-enables once a WatchFacts source DB is configured, with no separate manual opt-in needed", () => {
  const { config } = loadConfig({ WATCHFACTS_DB_URL: "postgres://example/db" });
  assert.equal(config.watchfacts.enableWtbSync, true);
});

test("WTB sync still defaults off when there is no source DB at all (the original unreliable-browser-path concern still applies)", () => {
  const { config } = loadConfig({ WATCHFACTS_DB_URL: undefined });
  assert.equal(config.watchfacts.enableWtbSync, false);
});

test("an explicit ENABLE_WTB_SYNC=false always wins, even with a source DB configured", () => {
  const { config } = loadConfig({ WATCHFACTS_DB_URL: "postgres://example/db", ENABLE_WTB_SYNC: "false" });
  assert.equal(config.watchfacts.enableWtbSync, false);
});

test("an explicit ENABLE_WTB_SYNC=true always wins, even with no source DB configured", () => {
  const { config } = loadConfig({ WATCHFACTS_DB_URL: undefined, ENABLE_WTB_SYNC: "true" });
  assert.equal(config.watchfacts.enableWtbSync, true);
});
