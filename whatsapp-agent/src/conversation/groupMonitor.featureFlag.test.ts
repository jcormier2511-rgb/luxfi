import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// ENABLE_V4_POSTINGS is deliberately left UNSET here — proving the documented default
// (config.postingsV4.enabled === false) actually keeps the v4 ingestion/notification path
// inert, per the "stays disabled in production until verified" requirement.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-groupmonitor-flag-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require("../config") as typeof import("../config");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const enrichment = require("../ai/enrichment") as typeof import("../ai/enrichment");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleGroupMessage } = require("./groupMonitor") as typeof import("./groupMonitor");

after(() => {
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

test("the v4 postings path defaults to disabled when ENABLE_V4_POSTINGS is unset", () => {
  assert.equal(config.postingsV4.enabled, false);
});

test("with the v4 flag off, a group WTB post is still captured to the legacy v3 CSV but never reaches postings ingestion or sends anything", async (t) => {
  const sent: unknown[] = [];
  t.mock.method(whapiClient, "sendText", async () => {
    sent.push(true);
  });

  await handleGroupMessage("m1", "g1", "15551234567", "Alex", "WTB Rolex Daytona 116500LN budget $30,000");

  assert.ok(fs.existsSync(config.data.groupListingsCsv), "the v3 CSV capture must still work regardless of the v4 flag");
  const csv = fs.readFileSync(config.data.groupListingsCsv, "utf-8");
  assert.match(csv, /WTB/);
  assert.equal(sent.length, 0, "no message of any kind should be sent while the v4 flag is off");
});

test("AI-enriched group rows persist RMB prices as canonical CNY", async (t) => {
  const originalEnrichmentFlag = config.aiMatching.enrichmentEnabled;
  config.aiMatching.enrichmentEnabled = true;
  t.after(() => {
    config.aiMatching.enrichmentEnabled = originalEnrichmentFlag;
  });
  t.mock.method(enrichment, "enrichListingText", async () => [
    {
      brand: "Patek Philippe", model: null, referenceRaw: "5712G", referenceFamily: "5712",
      variant: null, year: null, condition: null, price: 900000, currency: "RMB",
      location: null, confidence: 0.99, evidence: "Patek 5712G RMB 900000",
    },
    {
      brand: "Rolex", model: null, referenceRaw: "126333", referenceFamily: "126333",
      variant: null, year: null, condition: null, price: 137000, currency: "RMB",
      location: null, confidence: 0.99, evidence: "Rolex 126333 RMB 137000",
    },
  ]);

  await handleGroupMessage(
    "m2",
    "g1",
    "15551234567",
    "Alex",
    "FS Patek 5712G RMB 900000\nFS Rolex 126333 RMB 137000"
  );

  const csv = fs.readFileSync(config.data.groupListingsCsv, "utf-8");
  assert.match(csv, /,CNY 900000,,/);
  assert.match(csv, /,CNY 137000,,/);
  // The source evidence remains verbatim (and correctly still says RMB); only the persisted
  // structured price field must be canonicalized for the downstream FX parser.
  assert.doesNotMatch(csv, /,RMB (?:900000|137000),,/);
});
