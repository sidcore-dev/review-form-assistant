/*
 * The audit scanner must pass on the shipped tree, and the content script must
 * stay inside the behavioural limits the README promises.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanProject, isAllowedOrigin } from "../scripts/audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("project audit reports no findings", () => {
  const result = scanProject(ROOT);
  assert.deepEqual(result.findings, [], JSON.stringify(result.findings, null, 2));
});

test("audit accepts loopback origins and rejects everything unknown", () => {
  assert.equal(isAllowedOrigin("http://127.0.0.1:8787"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1"), true);
  assert.equal(isAllowedOrigin("https://api.openai.com"), true);
  assert.equal(isAllowedOrigin("https://evil.example"), false);
  assert.equal(isAllowedOrigin("http://10.0.0.5:8787"), false);
});

test("content script never targets submit or navigation controls", () => {
  const source = read("extension/content.js");
  [/querySelector[^\n]*button/i, /\bsubmit\b\s*\(/i, /form\.submit/i, /requestSubmit/i].forEach((pattern) =>
    assert.ok(!pattern.test(source), `content.js must not match ${pattern}`)
  );
});

test("content script performs no network calls", () => {
  const source = read("extension/content.js");
  [/\bfetch\s*\(/, /XMLHttpRequest/, /navigator\.sendBeacon/, /new\s+WebSocket/].forEach((pattern) =>
    assert.ok(!pattern.test(source), `content.js must not use ${pattern}`)
  );
});

test("content script touches no storage, cookie, or identity APIs", () => {
  const source = read("extension/content.js");
  [
    /chrome\.storage/,
    /chrome\.cookies/,
    /chrome\.history/,
    /chrome\.downloads/,
    /document\.cookie/,
    /localStorage/,
    /sessionStorage/
  ].forEach((pattern) => assert.ok(!pattern.test(source), `content.js must not use ${pattern}`));
});

test("content script only reads radio and checkbox questions", () => {
  const source = read("extension/content.js");
  assert.ok(source.includes('[role="radio"]'));
  assert.ok(source.includes('[role="checkbox"]'));
  assert.ok(!/input\[type="?text"?\]/.test(source));
  assert.ok(!/type="?email"?/.test(source));
});

test("popup talks to the local server and nothing else", () => {
  const source = read("extension/popup.js");
  const urls = source.match(/https?:\/\/[^\s"'`)<>\][{}$]+/g) ?? [];
  urls.forEach((url) => assert.ok(url.startsWith("http://127.0.0.1:8787"), `unexpected URL ${url}`));
  assert.ok(source.includes("http://127.0.0.1:8787/answer"));
});

test("popup enforces the 15 question batch limit before sending", () => {
  const source = read("extension/popup.js");
  assert.match(source, /MAX_QUESTIONS_PER_BATCH\s*=\s*15/);
  // Long forms are split into server-sized batches rather than truncated.
  assert.match(source, /chunk\(questions, MAX_QUESTIONS_PER_BATCH\)/);
});

test("no source file contains an API key", () => {
  ["extension/popup.js", "extension/content.js", "extension/manifest.json", "server.js"].forEach(
    (file) => {
      const source = read(file);
      assert.ok(!/\bsk-[A-Za-z0-9_-]{20,}/.test(source), `${file} must not contain a key`);
      assert.ok(!/OPENAI_API_KEY\s*=\s*["'][^"']+["']/.test(source), `${file} must not assign a key`);
    }
  );
});

test("the extension folder never references the API key at all", () => {
  ["extension/popup.js", "extension/content.js", "extension/popup.html", "extension/manifest.json"].forEach(
    (file) => assert.ok(!read(file).includes("OPENAI_API_KEY"), `${file} must not mention the key`)
  );
});

test("git ignores the real environment file", () => {
  assert.match(read(".gitignore"), /^\.env$/m);
});

test("the env template never contains a real-looking key", () => {
  const template = read(".env.example");
  assert.ok(!/\bsk-[A-Za-z0-9_-]{20,}/.test(template));
  assert.match(template, /^OPENAI_API_KEY=/m);
});

test("popup splits long forms into server-sized batches", () => {
  const source = read("extension/popup.js");
  assert.match(source, /const chunk = /);
  assert.match(source, /chunk\(questions, MAX_QUESTIONS_PER_BATCH\)/);
  assert.match(source, /MAX_QUESTIONS_PER_BATCH\s*=\s*15/);
});

test("popup retries only failures the server marked retryable", () => {
  const source = read("extension/popup.js");
  assert.match(source, /if \(!error\.retryable \|\| attempt >= RETRY_ATTEMPTS\) throw error;/);
});

test("popup still never references a submit or navigation control", () => {
  const source = read("extension/popup.js");
  /*
   * Matches on APIs, not on the word: the status text legitimately says
   * "Nothing was submitted."
   */
  [/\.submit\s*\(/, /requestSubmit/, /querySelector[^\n]*submit/i, /nextSection/i].forEach((pattern) =>
    assert.ok(!pattern.test(source), `popup.js must not match ${pattern}`)
  );
});

test("popup backs off exponentially and honours the provider's retry-after", () => {
  const source = read("extension/popup.js");
  assert.match(source, /RETRY_BASE_DELAY_MS \* 2 \*\* attempt/);
  assert.match(source, /error\.retryAfterSeconds/);
  assert.match(source, /Math\.max\(suggested, backoff\)/);
});

test("a failed batch does not abandon the rest of the form", () => {
  const source = read("extension/popup.js");
  // The loop must continue past a failure, never break out of it.
  assert.match(source, /failed\.push\(\{ batch: index \+ 1/);
  assert.ok(!/failure = `Stopped at/.test(source));
});

test("a LICENSE ships with the project", () => {
  const license = read("LICENSE");
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\)/);
});

test("no source file hardcodes a home directory path", () => {
  ["server.js", "setup.html", "extension/popup.js", "extension/content.js", "Install-macOS.command"].forEach(
    (file) => assert.ok(!/\/Users\/[a-z]/i.test(read(file)), `${file} must not hardcode a home path`)
  );
});
