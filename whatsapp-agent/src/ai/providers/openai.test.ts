import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.AI_MATCHING_OPENAI_MODEL = "gpt-test-model";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { callOpenAiJson } = require("./openai") as typeof import("./openai");

test("callOpenAiJson parses a valid chat-completions response", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, "gpt-test-model");
    assert.deepEqual(body.messages, [
      { role: "system", content: "sys" },
      { role: "user", content: "user text" },
    ]);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"action":"buy"}' } }] }),
    } as Response;
  });
  const result = await callOpenAiJson<{ action: string }>({ system: "sys", user: "user text" });
  assert.deepEqual(result, { action: "buy" });
});

test("callOpenAiJson strips a markdown fence the model might wrap the JSON in", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '```json\n{"action":"sell"}\n```' } }] }),
  }) as unknown as Response);
  const result = await callOpenAiJson<{ action: string }>({ system: "sys", user: "user text" });
  assert.deepEqual(result, { action: "sell" });
});

test("callOpenAiJson returns null on a non-2xx response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: false }) as Response);
  const result = await callOpenAiJson({ system: "sys", user: "user text" });
  assert.equal(result, null);
});

test("callOpenAiJson returns null (never throws) when fetch itself rejects", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network down");
  });
  const result = await callOpenAiJson({ system: "sys", user: "user text" });
  assert.equal(result, null);
});
