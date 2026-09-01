/* Offline tests for the local server. No network access: fetch is always stubbed. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  MAX_QUESTIONS,
  LOW_CONFIDENCE_THRESHOLD,
  OPENAI_URL,
  validateBatch,
  buildRequestBody,
  extractOutputText,
  normalizeAnswers,
  countLowConfidence,
  requestAnswers,
  describeApiError,
  PROVIDERS,
  DEFAULT_PROVIDER,
  getProvider,
  listModels,
  parseRetryAfter,
  readSettings,
  withEnv,
  isAllowedRequest,
  isAllowedHost,
  validateKey,
  withKey,
  readEnvFile,
  createServer
} from "../server.js";

const question = (id, choices = ["A", "B", "C"]) => ({ id, text: `Question ${id}?`, choices });

/* Shaped for both providers so a stub works whichever one is selected. */
const stubResponse = (answers) => ({
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({
      output_text: JSON.stringify({ answers }),
      choices: [{ message: { content: JSON.stringify({ answers }) } }]
    })
});

/* ---------------- validateBatch ---------------- */

test("validateBatch accepts a well-formed batch", () => {
  const result = validateBatch({ questions: [question("q1"), question("q2")] });
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "q1");
});

test("validateBatch rejects more than 15 questions", () => {
  const questions = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => question(`q${i}`));
  assert.throws(() => validateBatch({ questions }), /Batch limit is 15/);
});

test("validateBatch accepts exactly 15 questions", () => {
  const questions = Array.from({ length: MAX_QUESTIONS }, (_, i) => question(`q${i}`));
  assert.equal(validateBatch({ questions }).length, MAX_QUESTIONS);
});

test("validateBatch rejects malformed input", () => {
  assert.throws(() => validateBatch(null), /JSON object/);
  assert.throws(() => validateBatch({}), /'questions' array/);
  assert.throws(() => validateBatch({ questions: [] }), /No questions/);
  assert.throws(() => validateBatch({ questions: [{ text: "x", choices: ["a", "b"] }] }), /no id/);
  assert.throws(() => validateBatch({ questions: [question("q1", ["only"])] }), /fewer than two/);
});

/* ---------------- request body ---------------- */

test("buildRequestBody uses strict Structured Outputs", () => {
  const body = buildRequestBody([question("q1")], "test-model");
  assert.equal(body.model, "test-model");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
});

test("buildRequestBody sends only question text and choices", () => {
  const payload = JSON.parse(buildRequestBody([question("q1")])?.input[1].content);
  assert.deepEqual(Object.keys(payload.questions[0]).sort(), ["choices", "id", "text"]);
});

/* ---------------- output parsing ---------------- */

test("extractOutputText reads output_text and the nested fallback", () => {
  assert.equal(extractOutputText({ output_text: "hello" }), "hello");
  assert.equal(extractOutputText({ output: [{ content: [{ text: "nested" }] }] }), "nested");
  assert.throws(() => extractOutputText({}), /no text output/);
});

/* ---------------- normalizeAnswers ---------------- */

test("normalizeAnswers clamps confidence into 0..1", () => {
  const questions = [question("q1")];
  const answers = normalizeAnswers(
    [
      { id: "q1", index: 0, confidence: 4.2, explanation: "over" }
    ],
    questions
  );
  assert.equal(answers[0].confidence, 1);

  const negative = normalizeAnswers([{ id: "q1", index: 0, confidence: -3, explanation: "" }], questions);
  assert.equal(negative[0].confidence, 0);
});

test("normalizeAnswers drops unknown ids and out-of-range indexes", () => {
  const questions = [question("q1", ["A", "B"])];
  const answers = normalizeAnswers(
    [
      { id: "ghost", index: 0, confidence: 0.9, explanation: "" },
      { id: "q1", index: 7, confidence: 0.9, explanation: "" },
      { id: "q1", index: -1, confidence: 0.9, explanation: "" }
    ],
    questions
  );
  assert.deepEqual(answers, []);
});

test("normalizeAnswers keeps only the first answer per question", () => {
  const questions = [question("q1")];
  const answers = normalizeAnswers(
    [
      { id: "q1", index: 0, confidence: 0.8, explanation: "first" },
      { id: "q1", index: 2, confidence: 0.9, explanation: "second" }
    ],
    questions
  );
  assert.equal(answers.length, 1);
  assert.equal(answers[0].explanation, "first");
});

test("countLowConfidence uses the 65% threshold", () => {
  const answers = [{ confidence: 0.64 }, { confidence: 0.65 }, { confidence: 0.2 }];
  assert.equal(countLowConfidence(answers, LOW_CONFIDENCE_THRESHOLD), 2);
});

/* ---------------- requestAnswers ---------------- */

test("requestAnswers refuses to run without a key", async () => {
  await assert.rejects(() => requestAnswers([question("q1")], { apiKey: "" }), /No .* API key is set/);
});

test("requestAnswers sends the key as a bearer token to the OpenAI endpoint only", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return stubResponse([{ id: "q1", index: 1, confidence: 0.9, explanation: "because" }]);
  };

  const answers = await requestAnswers([question("q1")], {
    apiKey: "sk-test",
    providerId: "openai",
    fetchImpl
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, OPENAI_URL);
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.deepEqual(answers, [{ id: "q1", index: 1, confidence: 0.9, explanation: "because" }]);
});

test("requestAnswers does not leak the key into thrown errors", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => "sk-leaked-in-body" });

  await assert.rejects(
    () => requestAnswers([question("q1")], { apiKey: "sk-secret", providerId: "openai", fetchImpl }),
    (error) => {
      assert.ok(!error.message.includes("sk-secret"));
      assert.ok(!error.message.includes("sk-leaked-in-body"));
      assert.match(error.message, /rejected the API key/);
      return true;
    }
  );
});

/* ---------------- access control ---------------- */

test("isAllowedRequest permits loopback callers from extension pages", () => {
  assert.equal(isAllowedRequest("127.0.0.1", "chrome-extension://abc"), true);
  assert.equal(isAllowedRequest("::1", undefined), true);
  assert.equal(isAllowedRequest("::ffff:127.0.0.1", "chrome-extension://abc"), true);
});

test("isAllowedRequest rejects remote callers and web page origins", () => {
  assert.equal(isAllowedRequest("192.168.1.20", "chrome-extension://abc"), false);
  assert.equal(isAllowedRequest("127.0.0.1", "https://docs.google.com"), false);
  assert.equal(isAllowedRequest("127.0.0.1", "http://evil.example"), false);
});

/* ---------------- HTTP path, still offline ---------------- */

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

test("POST /answer returns normalized answers over loopback", async (t) => {
  const fetchImpl = async () =>
    stubResponse([{ id: "q1", index: 2, confidence: 0.42, explanation: "unsure" }]);

  const server = createServer({ apiKey: "sk-test", fetchImpl });
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "chrome-extension://abc" },
    body: JSON.stringify({ questions: [question("q1")] })
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.answers, [{ id: "q1", index: 2, confidence: 0.42, explanation: "unsure" }]);
});

test("POST /answer rejects an oversized batch with 400", async (t) => {
  const server = createServer({ apiKey: "sk-test", fetchImpl: async () => stubResponse([]) });
  const port = await listen(server);
  t.after(() => server.close());

  const questions = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => question(`q${i}`));
  const response = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questions })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Batch limit is 15/);
});

test("a web page origin is refused with 403", async (t) => {
  const server = createServer({ apiKey: "sk-test", fetchImpl: async () => stubResponse([]) });
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://docs.google.com" },
    body: JSON.stringify({ questions: [question("q1")] })
  });

  assert.equal(response.status, 403);
});

test("unknown routes return 404", async (t) => {
  const server = createServer({ apiKey: "sk-test", fetchImpl: async () => stubResponse([]) });
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/submit`, { method: "POST" });
  assert.equal(response.status, 404);
});

/* ---------------- setup page and key handling ---------------- */

test("validateKey rejects blank, short, and whitespace-bearing keys", () => {
  assert.throws(() => validateKey(""), /Enter a key/);
  assert.throws(() => validateKey("   "), /Enter a key/);
  assert.throws(() => validateKey("sk-short"), /too short/);
  assert.throws(() => validateKey("sk-with space in it and long enough"), /whitespace/);
  assert.equal(validateKey("  sk-abcdefghijklmnopqrstuvwx  "), "sk-abcdefghijklmnopqrstuvwx");
});

test("withKey appends a key to an empty env file", () => {
  assert.equal(withKey("", "sk-new"), "OPENAI_API_KEY=sk-new\n");
});

test("withKey replaces an existing key and preserves other lines", () => {
  const before = "# comment\nOPENAI_API_KEY=sk-old\nOPENAI_MODEL=gpt-4.1-mini\n";
  const after = withKey(before, "sk-new");
  assert.match(after, /^OPENAI_API_KEY=sk-new$/m);
  assert.ok(!after.includes("sk-old"));
  assert.match(after, /^OPENAI_MODEL=gpt-4\.1-mini$/m);
  assert.match(after, /^# comment$/m);
});

test("isAllowedHost blocks non-loopback Host headers", () => {
  assert.equal(isAllowedHost("127.0.0.1:8787"), true);
  assert.equal(isAllowedHost("localhost:8787"), true);
  assert.equal(isAllowedHost("attacker.example"), false);
  assert.equal(isAllowedHost("evil.example:8787"), false);
});

test("isAllowedRequest accepts the server's own setup page origin", () => {
  assert.equal(isAllowedRequest("127.0.0.1", "http://127.0.0.1:8787"), true);
  assert.equal(isAllowedRequest("127.0.0.1", "http://localhost:8787"), true);
  assert.equal(isAllowedRequest("127.0.0.1", "http://127.0.0.1.evil.example"), false);
});

test("GET /health reports key state without revealing the key", async (t) => {
  const server = createServer({ apiKey: "sk-supersecretvalue123456", fetchImpl: async () => stubResponse([]) });
  const port = await listen(server);
  t.after(() => server.close());

  const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(body.keyConfigured, true);
  assert.ok(!JSON.stringify(body).includes("sk-supersecretvalue123456"));
});

test("GET /setup serves the setup page", async (t) => {
  const server = createServer({ apiKey: "", fetchImpl: async () => stubResponse([]) });
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/setup`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const page = await response.text();
  assert.match(page, /API key/);
  assert.match(page, /Provider/);
});

test("POST /setup writes the key to a 0600 env file and activates it", async (t) => {
  const envFile = path.join(os.tmpdir(), `rfa-env-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(envFile, { force: true }));

  const server = createServer({ apiKey: "", envFile, fetchImpl: async () => stubResponse([]) });
  const port = await listen(server);
  t.after(() => server.close());

  const before = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(before.keyConfigured, false);

  const response = await fetch(`http://127.0.0.1:${port}/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ provider: "openai", key: "sk-abcdefghijklmnopqrstuvwxyz" })
  });
  assert.equal(response.status, 200);

  assert.match(fs.readFileSync(envFile, "utf8"), /^OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz$/m);
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);

  const after = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(after.keyConfigured, true);
});

test("POST /setup rejects a bad key with 400", async (t) => {
  const envFile = path.join(os.tmpdir(), `rfa-env-bad-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(envFile, { force: true }));

  const server = createServer({ apiKey: "", envFile, fetchImpl: async () => stubResponse([]) });
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "nope" })
  });

  assert.equal(response.status, 400);
  assert.equal(fs.existsSync(envFile), false);
});

test("POST /answer without a configured key explains how to fix it", async (t) => {
  const server = createServer({ apiKey: "", fetchImpl: async () => stubResponse([]) });
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questions: [question("q1")] })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /setup/);
});

/*
 * fetch() refuses to set a Host header, so this uses the raw client to simulate
 * a DNS rebinding attempt: loopback socket, attacker-controlled hostname.
 */
const rawGet = (port, headers) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/health", method: "GET", headers },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.end();
  });

test("a forged Host header is refused with 403", async (t) => {
  const server = createServer({ apiKey: "sk-test", fetchImpl: async () => stubResponse([]) });
  const port = await listen(server);
  t.after(() => server.close());

  assert.equal(await rawGet(port, { Host: "attacker.example" }), 403);
  assert.equal(await rawGet(port, { Host: `127.0.0.1:${port}` }), 200);
});

/* ---------------- API error messages ---------------- */

const quotaBody = JSON.stringify({
  error: { message: "You have no credits remaining.", type: "insufficient_quota", code: "credit_balance_exhausted" }
});

test("describeApiError explains an exhausted credit balance", () => {
  const message = describeApiError(429, quotaBody);
  assert.match(message, /no credits left/);
  assert.ok(!message.includes("429"));
});

test("describeApiError separates rate limiting from missing credit", () => {
  const rateLimited = describeApiError(429, JSON.stringify({ error: { type: "rate_limit_error" } }));
  assert.match(rateLimited, /rate limit/i);
  assert.ok(!/credits/.test(rateLimited));
});

test("describeApiError points a bad key at the setup page", () => {
  assert.match(describeApiError(401, "{}"), /setup/);
});

test("describeApiError names the unusable model", () => {
  assert.match(describeApiError(404, "{}", "gpt-nonexistent"), /gpt-nonexistent/);
  assert.match(
    describeApiError(400, JSON.stringify({ error: { code: "model_not_found" } }), "gpt-nope"),
    /gpt-nope/
  );
});

test("describeApiError falls back to the status for unknown failures", () => {
  assert.match(describeApiError(418, "not json at all"), /HTTP 418/);
  assert.match(describeApiError(503, "{}"), /HTTP 503/);
});

test("describeApiError never echoes the response body", () => {
  const body = JSON.stringify({ error: { message: "sk-leaked and secret question text", type: "x" } });
  const message = describeApiError(400, body);
  assert.ok(!message.includes("sk-leaked"));
  assert.ok(!message.includes("secret question text"));
});

test("requestAnswers surfaces the actionable message, not the raw body", async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => quotaBody });

  await assert.rejects(
    () => requestAnswers([question("q1")], { apiKey: "sk-test", fetchImpl }),
    /no credits left/
  );
});

/* ---------------- env file loading ---------------- */

test("readEnvFile returns an empty object for a missing file", () => {
  assert.deepEqual(readEnvFile(path.join(os.tmpdir(), "rfa-does-not-exist")), {});
});

test("readEnvFile parses keys, skips comments, and strips quotes", (t) => {
  const file = path.join(os.tmpdir(), `rfa-parse-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(file, { force: true }));

  fs.writeFileSync(
    file,
    ["# a comment", "OPENAI_API_KEY=sk-from-file", 'OPENAI_MODEL="gpt-4.1-mini"', "", "PORT = 9000"].join("\n")
  );

  assert.deepEqual(readEnvFile(file), {
    OPENAI_API_KEY: "sk-from-file",
    OPENAI_MODEL: "gpt-4.1-mini",
    PORT: "9000"
  });
});

test("a key saved to .env survives a server restart", async (t) => {
  const envFile = path.join(os.tmpdir(), `rfa-restart-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(envFile, { force: true }));

  // First server: no key, save one through the setup endpoint.
  const first = createServer({ apiKey: "", envFile, fetchImpl: async () => stubResponse([]) });
  const firstPort = await listen(first);

  await fetch(`http://127.0.0.1:${firstPort}/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "sk-persisted-across-restart-123" })
  });
  first.close();

  // Second server: fresh process state, key must come back from the file.
  const second = createServer({ apiKey: undefined, envFile, fetchImpl: async () => stubResponse([]) });
  const secondPort = await listen(second);
  t.after(() => second.close());

  const health = await (await fetch(`http://127.0.0.1:${secondPort}/health`)).json();
  assert.equal(health.keyConfigured, true);
});

/* ---------------- retry signalling ---------------- */

test("a rate limit is reported as retryable", async (t) => {
  const body = JSON.stringify({ error: { type: "rate_limit_error" } });
  const server = createServer({
    apiKey: "sk-test",
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => body })
  });
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questions: [question("q1")] })
  });

  const payload = await response.json();
  assert.equal(payload.retryable, true);
  assert.match(payload.error, /rate limit/i);
});

test("an exhausted credit balance is NOT retryable", async (t) => {
  const server = createServer({
    apiKey: "sk-test",
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => quotaBody })
  });
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questions: [question("q1")] })
  });

  const payload = await response.json();
  assert.equal(payload.retryable, false);
  assert.match(payload.error, /no credits left/);
});

test("a bad key is NOT retryable", async (t) => {
  const server = createServer({
    apiKey: "sk-test",
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => "{}" })
  });
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questions: [question("q1")] })
  });

  assert.equal((await response.json()).retryable, false);
});

/* ---------------- providers ---------------- */

test("both providers are registered with distinct endpoints and key variables", () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ["groq", "openai"]);
  assert.equal(PROVIDERS.groq.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(PROVIDERS.openai.url, "https://api.openai.com/v1/responses");
  assert.equal(PROVIDERS.groq.keyVar, "GROQ_API_KEY");
  assert.equal(PROVIDERS.openai.keyVar, "OPENAI_API_KEY");
});

test("getProvider falls back to the default rather than throwing", () => {
  assert.equal(getProvider("groq").id, "groq");
  assert.equal(getProvider("nonsense").id, DEFAULT_PROVIDER);
  assert.equal(getProvider(undefined).id, DEFAULT_PROVIDER);
});

test("the groq body uses chat completions with JSON mode", () => {
  const body = buildRequestBody([question("q1")], "openai/gpt-oss-120b", "groq");
  assert.equal(body.model, "openai/gpt-oss-120b");
  assert.equal(body.response_format.type, "json_object");
  assert.equal(body.temperature, 0);
  assert.equal(body.messages.length, 2);
  // JSON mode does not enforce a schema, so the shape must be in the prompt.
  assert.match(body.messages[0].content, /"answers"/);
  assert.match(body.messages[0].content, /zero-based/);
});

test("the openai body still uses strict structured outputs", () => {
  const body = buildRequestBody([question("q1")], undefined, "openai");
  assert.equal(body.text.format.strict, true);
  assert.equal(body.model, PROVIDERS.openai.defaultModel);
});

test("requestAnswers routes to groq and reads the chat completion shape", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return stubResponse([{ id: "q1", index: 0, confidence: 0.7, explanation: "ok" }]);
  };

  const answers = await requestAnswers([question("q1")], {
    apiKey: "gsk-test",
    providerId: "groq",
    fetchImpl
  });

  assert.equal(calls[0].url, PROVIDERS.groq.url);
  assert.equal(calls[0].init.headers.Authorization, "Bearer gsk-test");
  assert.deepEqual(answers, [{ id: "q1", index: 0, confidence: 0.7, explanation: "ok" }]);
});

test("a JSON-mode reply wrapped in markdown fences is still parsed", async () => {
  const inner = JSON.stringify({ answers: [{ id: "q1", index: 1, confidence: 0.5, explanation: "x" }] });
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ choices: [{ message: { content: "```json\n" + inner + "\n```" } }] })
  });

  const answers = await requestAnswers([question("q1")], {
    apiKey: "gsk-test",
    providerId: "groq",
    fetchImpl
  });
  assert.equal(answers[0].index, 1);
});

test("a groq reply with the wrong shape is filtered out, not trusted", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                answers: [
                  { id: "q1", index: 99, confidence: 0.9, explanation: "out of range" },
                  { id: "unknown", index: 0, confidence: 0.9, explanation: "not asked" }
                ]
              })
            }
          }
        ]
      })
  });

  const answers = await requestAnswers([question("q1")], {
    apiKey: "gsk-test",
    providerId: "groq",
    fetchImpl
  });
  assert.deepEqual(answers, []);
});

test("error messages name the provider that failed", () => {
  assert.match(describeApiError(401, "{}", "m", PROVIDERS.groq), /Groq/);
  assert.match(describeApiError(401, "{}", "m", PROVIDERS.openai), /OpenAI/);
});

/* ---------------- settings persistence ---------------- */

test("withEnv writes several entries and preserves unrelated lines", () => {
  const before = "# note\nOPENAI_API_KEY=sk-old\nPORT=8787\n";
  const after = withEnv(before, { PROVIDER: "groq", GROQ_API_KEY: "gsk-new" });

  assert.match(after, /^PROVIDER=groq$/m);
  assert.match(after, /^GROQ_API_KEY=gsk-new$/m);
  assert.match(after, /^OPENAI_API_KEY=sk-old$/m);
  assert.match(after, /^PORT=8787$/m);
  assert.match(after, /^# note$/m);
});

test("readSettings picks the provider and its own key out of the file", (t) => {
  const file = path.join(os.tmpdir(), `rfa-settings-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(file, { force: true }));

  fs.writeFileSync(file, "PROVIDER=groq\nGROQ_API_KEY=gsk-a\nOPENAI_API_KEY=sk-b\nMODEL=custom-model\n");
  const settings = readSettings(file);

  assert.equal(settings.providerId, "groq");
  assert.equal(settings.model, "custom-model");
  assert.equal(settings.keys.groq, "gsk-a");
  assert.equal(settings.keys.openai, "sk-b");
});

test("switching provider keeps the other provider's key", async (t) => {
  const envFile = path.join(os.tmpdir(), `rfa-switch-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(envFile, { force: true }));
  fs.writeFileSync(envFile, "PROVIDER=openai\nOPENAI_API_KEY=sk-keepthisone1234567\n");

  const server = createServer({ envFile, fetchImpl: async () => stubResponse([]) });
  const port = await listen(server);
  t.after(() => server.close());

  const saved = await fetch(`http://127.0.0.1:${port}/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "groq", key: "gsk-abcdefghijklmnopqrs" })
  });
  assert.equal(saved.status, 200);

  const text = fs.readFileSync(envFile, "utf8");
  assert.match(text, /^PROVIDER=groq$/m);
  assert.match(text, /^GROQ_API_KEY=gsk-abcdefghijklmnopqrs$/m);
  assert.match(text, /^OPENAI_API_KEY=sk-keepthisone1234567$/m, "the OpenAI key must survive");

  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.provider, "groq");
  assert.equal(health.keyConfigured, true);
  assert.ok(!JSON.stringify(health).includes("gsk-abcdefghijklmnopqrs"));
  assert.ok(!JSON.stringify(health).includes("sk-keepthisone1234567"));
});

test("switching back to a provider that already has a key needs no key re-entry", async (t) => {
  const envFile = path.join(os.tmpdir(), `rfa-back-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(envFile, { force: true }));
  fs.writeFileSync(envFile, "PROVIDER=groq\nGROQ_API_KEY=gsk-aaaaaaaaaaaaaaaaaaa\nOPENAI_API_KEY=sk-bbbbbbbbbbbbbbbbbbb\n");

  const server = createServer({ envFile, fetchImpl: async () => stubResponse([]) });
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "openai" })
  });

  assert.equal(response.status, 200);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.provider, "openai");
  assert.equal(health.keyConfigured, true);
});

test("an unknown provider is rejected", async (t) => {
  const envFile = path.join(os.tmpdir(), `rfa-bad-provider-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(envFile, { force: true }));

  const server = createServer({ envFile, fetchImpl: async () => stubResponse([]) });
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "definitely-not-real", key: "gsk-abcdefghijklmnopqrs" })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Unknown provider/);
});

test("an existing single-provider setup is not silently switched", (t) => {
  const file = path.join(os.tmpdir(), `rfa-legacy-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(file, { force: true }));

  // No PROVIDER line, only an OpenAI key: the way .env looked before providers.
  fs.writeFileSync(file, "OPENAI_API_KEY=sk-legacy-key-1234567890\n");
  const settings = readSettings(file);

  assert.equal(settings.providerId, "openai");
  assert.equal(settings.model, PROVIDERS.openai.defaultModel);
});

test("an explicit PROVIDER always wins over key presence", (t) => {
  const file = path.join(os.tmpdir(), `rfa-explicit-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(file, { force: true }));

  fs.writeFileSync(file, "PROVIDER=groq\nOPENAI_API_KEY=sk-legacy-key-1234567890\n");
  assert.equal(readSettings(file).providerId, "groq");
});

test("an empty install falls back to the default provider", (t) => {
  const file = path.join(os.tmpdir(), `rfa-empty-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(file, { force: true }));

  fs.writeFileSync(file, "# nothing configured\n");
  assert.equal(readSettings(file).providerId, DEFAULT_PROVIDER);
});

/* ---------------- model discovery ---------------- */

const modelsResponse = (ids) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ data: ids.map((id) => ({ id })) })
});

test("listModels returns nothing without a key rather than calling out", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return modelsResponse(["a"]);
  };

  assert.deepEqual(await listModels({ apiKey: "", providerId: "groq", fetchImpl }), []);
  assert.equal(called, false);
});

test("listModels drops models that cannot answer a question", async () => {
  const fetchImpl = async () =>
    modelsResponse([
      "openai/gpt-oss-120b",
      "whisper-large-v3",
      "meta-llama/llama-prompt-guard-2-86m",
      "qwen/qwen3.8-27b",
      "canopylabs/orpheus-v1-english",
      "text-embedding-3-small"
    ]);

  const models = await listModels({ apiKey: "gsk-test", providerId: "groq", fetchImpl });
  assert.deepEqual(models, ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
});

test("listModels degrades to an empty list instead of throwing", async () => {
  const failing = async () => { throw new Error("network down"); };
  assert.deepEqual(await listModels({ apiKey: "gsk-test", providerId: "groq", fetchImpl: failing }), []);

  const rejected = async () => ({ ok: false, status: 401, text: async () => "{}" });
  assert.deepEqual(await listModels({ apiKey: "gsk-test", providerId: "groq", fetchImpl: rejected }), []);

  const garbage = async () => ({ ok: true, status: 200, text: async () => "not json" });
  assert.deepEqual(await listModels({ apiKey: "gsk-test", providerId: "groq", fetchImpl: garbage }), []);
});

test("listModels queries the provider's own models endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return modelsResponse(["openai/gpt-oss-120b"]);
  };

  await listModels({ apiKey: "gsk-test", providerId: "groq", fetchImpl });
  assert.equal(calls[0].url, PROVIDERS.groq.modelsUrl);
  assert.equal(calls[0].init.headers.Authorization, "Bearer gsk-test");
});

test("GET /models serves the usable list without exposing the key", async (t) => {
  const envFile = path.join(os.tmpdir(), `rfa-models-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(envFile, { force: true }));
  fs.writeFileSync(envFile, "PROVIDER=groq\nGROQ_API_KEY=gsk-secretkey1234567890\n");

  const server = createServer({
    envFile,
    fetchImpl: async () => modelsResponse(["openai/gpt-oss-120b", "whisper-large-v3"])
  });
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/models`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.provider, "groq");
  assert.deepEqual(body.models, ["openai/gpt-oss-120b"]);
  assert.ok(!JSON.stringify(body).includes("gsk-secretkey1234567890"));
});

/* ---------------- retry-after handling ---------------- */

const withHeaders = (headers) => ({ get: (name) => headers[name.toLowerCase()] ?? null });

test("parseRetryAfter reads the standard header", () => {
  assert.equal(parseRetryAfter({ headers: withHeaders({ "retry-after": "17" }) }, ""), 17);
});

test("parseRetryAfter falls back to the seconds quoted in the body", () => {
  const body = JSON.stringify({
    error: { message: "Rate limit reached. Please try again in 8.53s.", type: "rate_limit_error" }
  });
  assert.equal(parseRetryAfter({ headers: withHeaders({}) }, body), 9);
});

test("parseRetryAfter understands minutes in the body", () => {
  const body = "Rate limit reached, try again in 2m";
  assert.equal(parseRetryAfter({ headers: withHeaders({}) }, body), 120);
});

test("parseRetryAfter returns 0 when the provider says nothing", () => {
  assert.equal(parseRetryAfter({ headers: withHeaders({}) }, "{}"), 0);
  assert.equal(parseRetryAfter({}, "{}"), 0);
  assert.equal(parseRetryAfter({ headers: withHeaders({ "retry-after": "nonsense" }) }, ""), 0);
});

test("parseRetryAfter caps an absurd wait", () => {
  assert.equal(parseRetryAfter({ headers: withHeaders({ "retry-after": "99999" }) }, ""), 120);
});

test("a rate limited answer response carries the wait the provider asked for", async (t) => {
  const body = JSON.stringify({ error: { message: "try again in 12s", type: "rate_limit_error" } });
  const server = createServer({
    apiKey: "gsk-test",
    providerId: "groq",
    fetchImpl: async () => ({ ok: false, status: 429, headers: withHeaders({}), text: async () => body })
  });
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questions: [question("q1")] })
  });

  const payload = await response.json();
  assert.equal(payload.retryable, true);
  assert.equal(payload.retryAfterSeconds, 12);
});
