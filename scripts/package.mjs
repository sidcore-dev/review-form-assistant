/*
 * Packaging pipeline. Every gate must pass before a zip is produced:
 *   1. JavaScript syntax check on every .js / .mjs file
 *   2. manifest.json parses and is Manifest V3
 *   3. offline test suite
 *   4. permission and endpoint audit
 *   5. zip, then print exact byte size and SHA-256
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { scanProject, printReport } from "./audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZIP_NAME = "Review-Form-Assistant.zip";
const ZIP_PATH = path.join(ROOT, ZIP_NAME);

/* Contents of the bundle. Source and tests ship so the recipient can audit. */
const CONTENTS = [
  "extension",
  "test",
  "scripts",
  "server.js",
  "setup.html",
  "package.json",
  ".env.example",
  ".gitignore",
  "README.md",
  "LICENSE",
  "Install-macOS.command",
  "Install-Windows.bat",
  "Stop-Server.command"
];

const step = (label) => console.log(`\n== ${label} ==`);

const fail = (message) => {
  console.error(`\nPACKAGING ABORTED: ${message}`);
  process.exit(1);
};

/** Every JavaScript file in the tree, excluding build noise. */
const jsFiles = (dir, collected = []) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((accumulator, entry) => {
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "dist"].includes(entry.name)) return accumulator;
      return jsFiles(path.join(dir, entry.name), accumulator);
    }
    return /\.(js|mjs)$/.test(entry.name) ? accumulator.concat(path.join(dir, entry.name)) : accumulator;
  }, collected);

/* 1. Syntax ------------------------------------------------------- */
step("JavaScript syntax check");
const sources = jsFiles(ROOT);
sources.forEach((file) => {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    console.log(`  ok  ${path.relative(ROOT, file)}`);
  } catch (error) {
    console.error(String(error.stderr ?? error.message));
    fail(`syntax error in ${path.relative(ROOT, file)}`);
  }
});

/* 2. Manifest ----------------------------------------------------- */
step("manifest.json validation");
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/manifest.json"), "utf8"));
} catch (error) {
  fail(`manifest.json does not parse: ${error.message}`);
}
if (manifest.manifest_version !== 3) fail("manifest.json is not Manifest V3");
["name", "version", "action", "content_scripts"].forEach((key) => {
  if (!manifest[key]) fail(`manifest.json is missing '${key}'`);
});
console.log(`  ok  Manifest V3, ${manifest.name} v${manifest.version}`);

/* 3. Tests -------------------------------------------------------- */
step("Offline test suite");
try {
  const output = execFileSync(process.execPath, ["--test"], { cwd: ROOT, encoding: "utf8" });
  const summary = output.split("\n").filter((line) => /^# (tests|pass|fail)/.test(line));
  summary.forEach((line) => console.log(`  ${line.replace("# ", "")}`));
  if (!/^# fail 0$/m.test(output)) fail("test suite reported failures");
} catch (error) {
  console.error(String(error.stdout ?? "").split("\n").slice(-40).join("\n"));
  fail("test suite failed");
}

/* 4. Audit -------------------------------------------------------- */
step("Permission and endpoint audit");
const auditResult = scanProject(ROOT);
if (printReport(auditResult) !== 0) fail("audit reported findings");

/* 5. Package ------------------------------------------------------ */
step("Packaging");
fs.rmSync(ZIP_PATH, { force: true });

try {
  execFileSync(
    "zip",
    [
      "-r",
      "-q",
      "-X",
      ZIP_NAME,
      ...CONTENTS,
      "-x",
      "*.DS_Store",
      "-x",
      "*/node_modules/*",
      "-x",
      "*.env",
      "-x",
      "*server.log"
    ],
    { cwd: ROOT }
  );
} catch (error) {
  fail(`zip failed: ${error.message}`);
}

/* 6. Secret sweep on the built archive ---------------------------- */
step("Secret sweep on the built archive");

const FORBIDDEN_ENTRIES = [/(^|\/)\.env$/, /(^|\/)server\.log$/, /(^|\/)node_modules\//, /\.pem$/];

/*
 * Prefixes that only ever appear on a genuine issued credential. Test fixtures
 * in this repo use plain "sk-" followed by lowercase filler, which is why they
 * do not trip this.
 */
const REAL_KEY_PATTERNS = [
  { label: "OpenAI project key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}/ },
  { label: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: "Groq key", re: /\bgsk_[A-Za-z0-9]{20,}/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "long opaque sk- key", re: /\bsk-[A-Za-z0-9]{40,}/ },
  { label: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }
];

/*
 * The secret values currently sitting in the local .env, so the check is exact
 * rather than a guess at what a key looks like.
 *
 * Only secret-named variables count. PROVIDER and MODEL are configuration that
 * legitimately appears in the README and in server.js, and treating those as
 * secrets makes the check cry wolf on every build.
 */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

const localSecrets = (() => {
  try {
    return fs
      .readFileSync(path.join(ROOT, ".env"), "utf8")
      .split("\n")
      .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)\s*$/))
      .filter((match) => match && SECRET_NAME.test(match[1]))
      .map((match) => match[2].trim().replace(/^(['"])(.*)\1$/, "$2"))
      .filter((value) => value.length >= 12);
  } catch {
    return [];
  }
})();

console.log(`  comparing against ${localSecrets.length} value(s) from the local .env`);

const listing = execFileSync("unzip", ["-Z1", ZIP_NAME], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const leaks = [];

listing.forEach((entry) => {
  FORBIDDEN_ENTRIES.forEach((pattern) => {
    if (pattern.test(entry)) leaks.push(`archive contains ${entry}`);
  });
});

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-verify-"));
try {
  execFileSync("unzip", ["-q", ZIP_PATH, "-d", scratch]);

  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });

  walk(scratch).forEach((file) => {
    const relative = path.relative(scratch, file);
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      return; // binary, nothing to leak in this project
    }

    REAL_KEY_PATTERNS.forEach(({ label, re }) => {
      if (re.test(content)) leaks.push(`${relative}: ${label}`);
    });

    localSecrets.forEach((secret) => {
      if (content.includes(secret)) leaks.push(`${relative}: a value from your local .env`);
    });

    if (content.includes(os.homedir())) leaks.push(`${relative}: absolute home directory path`);
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

if (leaks.length > 0) {
  leaks.forEach((leak) => console.error(`  LEAK  ${leak}`));
  fs.rmSync(ZIP_PATH, { force: true });
  fail("secrets found in the archive. The zip has been deleted rather than shipped.");
}

console.log("  no keys, no .env, no logs, no home paths: safe to share");

const bytes = fs.readFileSync(ZIP_PATH);
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

console.log(`\n  file    ${ZIP_NAME}`);
console.log(`  path    ${ZIP_PATH}`);
console.log(`  size    ${bytes.length} bytes`);
console.log(`  sha256  ${sha256}`);
console.log("\nPACKAGING COMPLETE");
console.log("The extension is NOT installed. Loading it is a manual step; see README.md.");
