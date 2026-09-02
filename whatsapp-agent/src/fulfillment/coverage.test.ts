import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleCoverageCommand, upsertCoverage, listCoverage } = require("./coverage") as typeof import("./coverage");

after(() => db._closePoolForTests());

/**
 * server.ts calls handleCoverageCommand BEFORE conversation/flow.ts's listing-management
 * handling, so a target that reads as a listing reference must never be treated as a brand name
 * here -- otherwise "pause listing 1" or "remove #1 and 2" silently reports a coverage change for
 * a "brand" like "listing 1" that never matched any real alert, and the actual listing-management
 * command (in flow.ts) never runs at all.
 */
test("pause/resume/remove never treats a listing reference as a brand name", async () => {
  await db._resetDbForTests();
  const identity = "telegram:5559990001";

  assert.equal(await handleCoverageCommand(identity, "pause listing 1"), null);
  assert.equal(await handleCoverageCommand(identity, "remove #1 and 2"), null);
  assert.equal(await handleCoverageCommand(identity, "remove listing 1 and 2"), null);
  assert.equal(await handleCoverageCommand(identity, "resume 1"), null);

  assert.deepEqual(await listCoverage(identity), [], "no phantom coverage rows were created for these");
});

test("a real brand-name pause/resume/remove still works", async () => {
  await db._resetDbForTests();
  const identity = "telegram:5559990002";
  await upsertCoverage(identity, "Rolex");

  const reply = await handleCoverageCommand(identity, "pause rolex alerts");
  assert.match(reply ?? "", /Paused rolex WTB coverage/);
  const rows = await listCoverage(identity);
  assert.equal(rows[0].status, "paused");
});
