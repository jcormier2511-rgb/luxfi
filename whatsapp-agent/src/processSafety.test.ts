import { test } from "node:test";
import assert from "node:assert/strict";
import { handleUnhandledRejection, handleUncaughtException, installProcessSafetyNets } from "./processSafety";

test("an unhandled rejection is logged with its stack and does NOT bring the bot down", () => {
  const logged: string[] = [];
  handleUnhandledRejection(new Error("a stray background promise"), (m) => logged.push(m));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /unhandled promise rejection/);
  assert.match(logged[0], /a stray background promise/);
  assert.match(logged[0], /processSafety\.test/, "the stack must reach the logs — that is the whole point");
});

test("a non-Error rejection reason is still reported rather than printed as [object Object]", () => {
  const logged: string[] = [];
  handleUnhandledRejection({ code: "ECONNRESET", detail: "upstream" }, (m) => logged.push(m));
  assert.match(logged[0], /ECONNRESET/);
  handleUnhandledRejection("plain string reason", (m) => logged.push(m));
  assert.match(logged[1], /plain string reason/);
});

test("an uncaught exception logs its stack and exits non-zero for a clean restart", () => {
  const logged: string[] = [];
  const exits: number[] = [];
  handleUncaughtException(new Error("torn synchronous stack"), (m) => logged.push(m), (c) => exits.push(c));
  assert.match(logged[0], /uncaught exception/);
  assert.match(logged[0], /torn synchronous stack/);
  assert.deepEqual(exits, [1], "must exit non-zero so the platform restarts it");
});

test("installing the safety nets is idempotent, so a reload cannot stack duplicate listeners", () => {
  const before = { r: process.listenerCount("unhandledRejection"), e: process.listenerCount("uncaughtException") };
  installProcessSafetyNets();
  installProcessSafetyNets();
  const after = { r: process.listenerCount("unhandledRejection"), e: process.listenerCount("uncaughtException") };
  assert.ok(after.r <= Math.max(1, before.r), "no duplicate rejection listeners");
  assert.ok(after.e <= Math.max(1, before.e), "no duplicate exception listeners");
});
