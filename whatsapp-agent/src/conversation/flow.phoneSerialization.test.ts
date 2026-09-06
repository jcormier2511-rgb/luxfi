import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withPhoneSerialized } = require("./flow") as typeof import("./flow");

/** Resolves only once release() is called — lets a test control exactly when an in-flight
 *  call's own work "finishes", instead of racing on real timers. */
function deferred<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("required regression: two overlapping calls for the SAME phone are strictly serialized — the second never starts until the first has fully finished", async () => {
  const order: string[] = [];
  const first = deferred<void>();

  const callA = withPhoneSerialized("15551234567", async () => {
    order.push("A:start");
    await first.promise;
    order.push("A:end");
  });

  // Give callA's synchronous "A:start" a chance to run before callB is even issued, mirroring
  // the real bug: call B is issued while call A is still mid-flight (e.g. awaiting a slow DB
  // write), not before it.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["A:start"], "call A must have started before call B is issued");

  const callB = withPhoneSerialized("15551234567", async () => {
    order.push("B:start");
    order.push("B:end");
  });

  // Without serialization, B would run (and finish) here, before A ever resolves — exactly the
  // real bug: a second call reading/acting on state while the first is still in flight.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["A:start"], "call B must not start while call A is still in flight, even after a tick");

  first.release();
  await Promise.all([callA, callB]);
  assert.deepEqual(order, ["A:start", "A:end", "B:start", "B:end"], "B must only start after A has fully finished");
});

test("required: two DIFFERENT phones are NOT serialized against each other — one phone's slow call must never block another's", async () => {
  const order: string[] = [];
  const slow = deferred<void>();

  const callA = withPhoneSerialized("15551111111", async () => {
    order.push("A:start");
    await slow.promise;
    order.push("A:end");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["A:start"]);

  const callB = withPhoneSerialized("15552222222", async () => {
    order.push("B:start");
    order.push("B:end");
  });
  await callB;

  // B (a different phone) ran and finished entirely while A was still awaiting `slow`.
  assert.deepEqual(order, ["A:start", "B:start", "B:end"]);

  slow.release();
  await callA;
  assert.deepEqual(order, ["A:start", "B:start", "B:end", "A:end"]);
});

test("a later call still runs after an earlier one throws — one phone's failure must never permanently jam its queue", async () => {
  await assert.rejects(
    withPhoneSerialized("15553333333", async () => {
      throw new Error("boom");
    }),
    /boom/
  );

  const result = await withPhoneSerialized("15553333333", async () => "ok");
  assert.equal(result, "ok", "the queue must recover after a prior call rejected");
});
