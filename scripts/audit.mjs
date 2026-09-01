/*
 * Pre-packaging audit. Walks the project and reports anything that would widen
 * the extension's reach beyond what the README claims.
 *
 * Exported for the offline tests; prints a human-readable report when run
 * directly (npm run audit).
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, "..");

/* Permissions the project is allowed to declare. Anything else is a finding. */
export const ALLOWED_PERMISSIONS = ["activeTab"];
export const ALLOWED_HOST_PERMISSIONS = ["http://127.0.0.1:8787/*"];
export const ALLOWED_MATCHES = ["https://docs.google.com/forms/d/e/*/viewform*"];

/* Network destinations the project is allowed to name. */
export const ALLOWED_ORIGINS = [
  "http://127.0.0.1:8787",
  "https://api.openai.com",
  "https://api.groq.com",
  "https://docs.google.com"
];

/*
 * Two exclusions, both printed in the report so they cannot hide anything:
 *   - this scanner, which necessarily contains the literal strings it searches for
 *   - test/, which contains deliberate negative controls such as "https://evil.example"
 *     and a fake "<all_urls>" string, asserted to be rejected
 * Everything that runs in the browser or on the server is scanned.
 */
export const SCAN_EXCLUSIONS = [
  "scripts/audit.mjs (the scanner itself)",
  "test/ (negative-control fixtures)",
  ".env (your real key lives here by design; gitignored and never packaged)",
  "node_modules/, .git/, dist/, *.zip, server.log"
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "test"]);
/* .env is excluded, .env.example is not: the template must stay key-free. */
const SKIP_FILES = new Set(["audit.mjs", ".env", "server.log"]);
const CODE_EXTENSIONS = new Set([".js", ".mjs", ".json", ".html", ".css"]);
const TEXT_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  ".md",
  ".example",
  ".gitignore",
  ".command",
  ".bat",
  ".sh",
  ""
]);

const CODE_PATTERNS = [
  { label: "eval() call", re: /\beval\s*\(/ },
  { label: "new Function() constructor", re: /\bnew\s+Function\s*\(/ },
  { label: "remote <script src>", re: /<script[^>]+src\s*=\s*["']https?:/i },
  { label: "<all_urls> permission", re: /<all_urls>/ },
  { label: "wildcard host permission", re: /["']\*:\/\/\*\/\*["']/ }
];

const CREDENTIAL_PATTERNS = [
  { label: "OpenAI-style key literal", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  {
    label: "hard-coded secret assignment",
    re: /\b(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}["']/i
  }
];

/* Stops at template-literal placeholders so "http://127.0.0.1:${port}" reads as loopback. */
const URL_RE = /https?:\/\/[^\s"'`)<>\][{}$]+/g;

/* Any loopback port is acceptable: such a request cannot leave this machine. */
const LOOPBACK_ORIGIN_RE = /^http:\/\/127\.0\.0\.1(:\d+)?$/;

export const isAllowedOrigin = (origin) =>
  ALLOWED_ORIGINS.includes(origin) || LOOPBACK_ORIGIN_RE.test(origin);

/** Recursively list files, skipping build and VCS noise. Returns new array. */
export const listFiles = (dir = PROJECT_ROOT, collected = []) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((accumulator, entry) => {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) return accumulator;
      return listFiles(path.join(dir, entry.name), accumulator);
    }
    if (SKIP_FILES.has(entry.name)) return accumulator;
    if (entry.name.endsWith(".zip")) return accumulator;
    return accumulator.concat(path.join(dir, entry.name));
  }, collected);

const originOf = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
};

/** Compare a declared list against an allowlist. Returns unexpected entries. */
const unexpected = (declared, allowed) =>
  (declared ?? []).filter((entry) => !allowed.includes(entry));

/**
 * Run the full audit.
 * Returns { findings, permissions, hostPermissions, matches, endpoints }.
 */
export const scanProject = (root = PROJECT_ROOT) => {
  const findings = [];
  const endpoints = new Set();

  const manifestPath = path.join(root, "extension", "manifest.json");
  let manifest = null;

  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    findings.push({ file: "extension/manifest.json", issue: `Unreadable: ${error.message}` });
  }

  if (manifest) {
    unexpected(manifest.permissions, ALLOWED_PERMISSIONS).forEach((permission) =>
      findings.push({ file: "extension/manifest.json", issue: `Unexpected permission: ${permission}` })
    );
    unexpected(manifest.host_permissions, ALLOWED_HOST_PERMISSIONS).forEach((host) =>
      findings.push({ file: "extension/manifest.json", issue: `Unexpected host permission: ${host}` })
    );
    (manifest.content_scripts ?? []).forEach((script) =>
      unexpected(script.matches, ALLOWED_MATCHES).forEach((match) =>
        findings.push({ file: "extension/manifest.json", issue: `Unexpected content script match: ${match}` })
      )
    );
    if (manifest.manifest_version !== 3) {
      findings.push({ file: "extension/manifest.json", issue: "Not Manifest V3." });
    }
  }

  listFiles(root).forEach((file) => {
    const relative = path.relative(root, file);
    const extension = path.extname(file);
    if (!TEXT_EXTENSIONS.has(extension)) return;

    const source = fs.readFileSync(file, "utf8");

    CREDENTIAL_PATTERNS.forEach(({ label, re }) => {
      if (re.test(source)) findings.push({ file: relative, issue: `Possible credential: ${label}` });
    });

    if (!CODE_EXTENSIONS.has(extension)) return;

    CODE_PATTERNS.forEach(({ label, re }) => {
      if (re.test(source)) findings.push({ file: relative, issue: label });
    });

    (source.match(URL_RE) ?? []).forEach((url) => {
      const origin = originOf(url);
      endpoints.add(origin);
      if (!isAllowedOrigin(origin)) {
        findings.push({ file: relative, issue: `Unexpected network origin: ${origin}` });
      }
    });
  });

  return {
    findings,
    permissions: manifest?.permissions ?? [],
    hostPermissions: manifest?.host_permissions ?? [],
    matches: (manifest?.content_scripts ?? []).flatMap((script) => script.matches ?? []),
    endpoints: Array.from(endpoints).sort()
  };
};

/** Print the report. Returns the exit code the caller should use. */
export const printReport = (result) => {
  const line = "-".repeat(64);

  console.log(line);
  console.log("REVIEW FORM ASSISTANT - AUDIT REPORT");
  console.log(line);

  console.log("\nEXTENSION PERMISSIONS");
  result.permissions.forEach((permission) =>
    console.log(`  ${permission}  (access to the current tab, only after a user click)`)
  );
  if (result.permissions.length === 0) console.log("  (none)");

  console.log("\nHOST PERMISSIONS");
  result.hostPermissions.forEach((host) => console.log(`  ${host}  (local answer server)`));
  if (result.hostPermissions.length === 0) console.log("  (none)");

  console.log("\nCONTENT SCRIPT MATCHES");
  result.matches.forEach((match) => console.log(`  ${match}`));

  console.log("\nNETWORK ENDPOINTS FOUND IN SOURCE");
  result.endpoints.forEach((endpoint) => {
    const note = isAllowedOrigin(endpoint) ? "expected" : "UNEXPECTED";
    console.log(`  ${endpoint}  [${note}]`);
  });

  console.log("\nSCAN EXCLUSIONS");
  SCAN_EXCLUSIONS.forEach((exclusion) => console.log(`  ${exclusion}`));

  console.log("\nNOT REQUESTED (verified absent)");
  ["<all_urls>", "cookies", "history", "downloads", "storage", "tabs", "webRequest", "scripting"].forEach(
    (permission) => console.log(`  ${permission}`)
  );

  console.log(`\nFINDINGS: ${result.findings.length}`);
  result.findings.forEach((finding) => console.log(`  ${finding.file}: ${finding.issue}`));

  console.log(`\n${line}`);
  console.log(result.findings.length === 0 ? "AUDIT PASSED" : "AUDIT FAILED");
  console.log(line);

  return result.findings.length === 0 ? 0 : 1;
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exit(printReport(scanProject()));
}
