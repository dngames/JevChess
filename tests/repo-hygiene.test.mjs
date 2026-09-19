/**
 * Repository hygiene: things that must never be committed, and the guard that says so.
 *
 * This exists because `git add -A` swept a Cloudflare tool cache (`.wrangler/cache/
 * wrangler-account.json`) into a commit. It held no credential — an account id and name — but
 * it had no business in the repository, and nothing in the test suite would have noticed.
 *
 * It deliberately does not shell out to git: capturing a child process's output is blocked in
 * sandboxed environments, and a guard that cannot run everywhere is not much of a guard. It
 * checks the two things that are actually load-bearing — that the ignore list covers every
 * local artifact, and that no file in the tree contains a real API key assignment.
 *
 * Run with: node tests/repo-hygiene.test.mjs
 */

import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.message.split("\n").join("\n        ")}`);
  }
}

/** Paths that belong to a machine, not to the project. */
const MUST_BE_IGNORED = [
  ".env",
  ".wrangler/",
  ".vercel/",
  ".netlify/",
  "node_modules/",
  "experiments/",
];

/** Directories that are never worth walking. */
const SKIP_DIRS = new Set([".git", "node_modules", "screenshots", "experiments"]);

/** Conservative subset of gitignore syntax: the literal prefixes and globs we rely on. */
function isIgnored(relativePath, patterns) {
  const normalised = relativePath.split(sep).join("/");
  return patterns.some((pattern) => {
    if (pattern.endsWith("/")) return normalised === pattern.slice(0, -1) || normalised.startsWith(pattern);
    if (pattern.startsWith("*.")) return normalised.endsWith(pattern.slice(1));
    if (pattern.includes("*")) {
      const [prefix, suffix] = pattern.split("*");
      return normalised.startsWith(prefix) && normalised.endsWith(suffix);
    }
    return normalised === pattern || normalised.startsWith(`${pattern}/`);
  });
}

async function gitignorePatterns() {
  const text = await readFile(join(ROOT, ".gitignore"), "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function walk(directory, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(directory, entry.name), found);
    } else if (entry.isFile()) {
      found.push(join(directory, entry.name));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------

console.log("Repository hygiene\n");

await test(".gitignore covers every local artifact", async () => {
  const patterns = await gitignorePatterns();
  for (const required of MUST_BE_IGNORED) {
    assert.ok(
      patterns.some((pattern) => pattern === required || pattern === required.replace(/\/$/, "")),
      `".gitignore" has no rule for ${required}`,
    );
  }
});

await test("no local artifact present in the tree escapes the ignore list", async () => {
  const patterns = await gitignorePatterns();
  const suspects = [".env", ".wrangler", ".vercel", ".netlify", "node_modules"];
  for (const suspect of suspects) {
    let exists = true;
    try {
      await stat(join(ROOT, suspect));
    } catch {
      exists = false;
    }
    if (!exists) continue;
    assert.ok(isIgnored(suspect, patterns), `${suspect} exists on disk but is not ignored, so "git add -A" would commit it`);
  }
});

await test("no file in the tree carries a real API key assignment", async () => {
  const files = await walk(ROOT);
  const offenders = [];
  /**
   * Documentation is full of placeholders — `TYPESAFE_API_KEY=...`, `TYPESAFE_API_KEY=<key>`,
   * empty assignments in .env.example — and flagging those would make this check useless
   * noise. What a real key looks like is a long, opaque, unquoted token, so that is what is
   * looked for.
   */
  const looksLikeARealKey = (value) =>
    typeof value === "string" &&
    value.length >= 24 &&
    !/^["'`]/.test(value) &&
    !/[.<>{}*\s]/.test(value) &&
    /^[A-Za-z0-9_-]+$/.test(value);

  for (const file of files) {
    if (!/\.(js|mjs|json|md|txt|env|example|ya?ml|ps1|sh)$/i.test(file) && !file.endsWith(".env.example")) continue;
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!/TYPESAFE_API_KEY/.test(line)) continue;
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      const match = /TYPESAFE_API_KEY["'`]?\s*[=:]\s*["'`]?([^\s"'`,;)]+)/.exec(trimmed);
      if (match && looksLikeARealKey(match[1])) offenders.push(`${relative(ROOT, file)}: ${trimmed.slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, [], `a key looks committed:\n        ${offenders.join("\n        ")}`);
});

await test("the committed screenshot set is small enough to belong in a repository", async () => {
  // Evidence should be inspectable, not a dumping ground.
  const dir = join(ROOT, "screenshots");
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // screenshots are optional
  }
  const images = entries.filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name));
  for (const image of images) {
    const info = await stat(join(dir, image.name));
    assert.ok(info.size < 2_000_000, `${image.name} is ${Math.round(info.size / 1024)} KB; keep committed images under 2 MB`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.error.message}`);
  process.exitCode = 1;
}
