import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.AI_MATCHING_OPENAI_MODEL = "gpt-test-model";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { callOpenAiJson, runOpenAiDiagnosticCall } = require("./openai") as typeof import("./openai");

function errorResponse(status: number, body: unknown, requestId = "req_abc123"): Response {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => (name === "x-request-id" ? requestId : null) },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

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
  t.mock.method(globalThis, "fetch", async () =>
    errorResponse(400, { error: { message: "model not found", type: "invalid_request_error", code: "model_not_found", param: "model" } })
  );
  const result = await callOpenAiJson({ system: "sys", user: "user text" });
  assert.equal(result, null);
});

test("required regression: callOpenAiJson logs the structured OpenAI error (type/code/param/message/requestId), not just the raw body", async (t) => {
  const errorSpy = t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () =>
    errorResponse(400, { error: { message: "The model `gpt-5.6-luna` does not exist", type: "invalid_request_error", code: "model_not_found", param: null } })
  );
  await callOpenAiJson({ system: "sys", user: "user text" });
  const [, logged] = errorSpy.mock.calls[0].arguments;
  assert.equal(logged.status, 400);
  assert.equal(logged.type, "invalid_request_error");
  assert.equal(logged.code, "model_not_found");
  assert.equal(logged.message, "The model `gpt-5.6-luna` does not exist");
  assert.equal(logged.requestId, "req_abc123");
});

test("callOpenAiJson returns null (never throws) when fetch itself rejects", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network down");
  });
  const result = await callOpenAiJson({ system: "sys", user: "user text" });
  assert.equal(result, null);
});

test("runOpenAiDiagnosticCall calls the Responses API (not chat/completions) with the minimal payload", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, "gpt-test-model");
    assert.equal(body.input, "Return exactly OK.");
    assert.deepEqual(body.reasoning, { effort: "none" });
    assert.equal(body.max_output_tokens, 20);
    return { ok: true, status: 200, json: async () => ({ output_text: "OK" }) } as unknown as Response;
  });
  const result = await runOpenAiDiagnosticCall();
  assert.equal(result.ok, true);
  assert.equal(result.outputText, "OK");
});

test("required regression: runOpenAiDiagnosticCall surfaces the structured error on failure", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    errorResponse(400, { error: { message: "The model `gpt-5.6-luna` does not exist", type: "invalid_request_error", code: "model_not_found", param: null } })
  );
  const result = await runOpenAiDiagnosticCall();
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.error?.code, "model_not_found");
  assert.equal(result.error?.message, "The model `gpt-5.6-luna` does not exist");
  assert.equal(result.error?.requestId, "req_abc123");
});
