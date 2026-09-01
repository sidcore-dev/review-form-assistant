/* Offline checks on the shipped manifest. These encode the promises the README makes. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/manifest.json"), "utf8"));

test("is Manifest V3", () => {
  assert.equal(manifest.manifest_version, 3);
});

test("requests activeTab and nothing else", () => {
  assert.deepEqual(manifest.permissions, ["activeTab"]);
});

test("requests exactly one host permission, the local server", () => {
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1:8787/*"]);
});

test("declines every broad permission", () => {
  const declared = [...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])];
  ["<all_urls>", "cookies", "history", "downloads", "storage", "tabs", "webRequest", "scripting"].forEach(
    (permission) => assert.ok(!declared.includes(permission), `must not request ${permission}`)
  );
});

test("content script is limited to Google Forms viewform pages", () => {
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://docs.google.com/forms/d/e/*/viewform*"
  ]);
  assert.equal(manifest.content_scripts[0].all_frames, false);
});

test("declares no background service worker", () => {
  assert.equal(manifest.background, undefined);
});

test("exposes no web accessible resources", () => {
  assert.equal(manifest.web_accessible_resources, undefined);
});
