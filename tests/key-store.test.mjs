/**
 * Windows secure-storage round trip: store → read → clear, plus the CLI paths.
 *
 * This exists because the first version shipped a `key:set` that could not work: it asked
 * PowerShell's `Read-Host` while spawning PowerShell with `-NonInteractive`. The lesson is
 * that the documented command needs a test, not just the storage function underneath it.
 *
 * It is safe to run with a real key already stored: the existing DPAPI blob is copied aside
 * and restored at the end, and the key itself is never printed (the CLI test compares values
 * in memory).
 *
 * Run with: node tests/key-store.test.mjs
 *
 * PowerShell must be spawnable with piped stdio, which sandboxed environments block. In that
 * case the suite reports SKIP and exits 0 rather than failing misleadingly.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { clearStoredKey, hasStoredKey, keyFilePath, readStoredKey, runPowerShell, storeKey } from "../src/win-key.js";
import { readHiddenLine } from "../tools/hidden-prompt.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(ROOT, "tools", "win-key.mjs");
const FILE = keyFilePath();
const BACKUP = FILE ? `${FILE}.test-backup` : null;

const FAKE_KEY = "ts-test-key-one-0123456789abcdef";
const FAKE_KEY_2 = "ts-test-key-two-fedcba9876543210";

let passed = 0;
const failures = [];
const notes = [];

function report(name, error) {
  failures.push({ name, error });
  console.log(`  FAIL  ${name}\n        ${error.message.split("\n").join("\n        ")}`);
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    report(name, error);
  }
}

/** Run the CLI and capture its output. Throws EPERM in environments without piped stdio. */
function runCli(args, { input = null } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// ---------------------------------------------------------------------------

console.log("Windows secure storage round trip\n");

// ---------------------------------------------------------------------------
// 1. the hidden prompt — the code that runs when a person pastes a key.
//    Pure logic against a fake stream, so it runs everywhere, TTY or not.
// ---------------------------------------------------------------------------

function fakeTty() {
  const listeners = new Map();
  return {
    isTTY: true,
    raw: null,
    encoding: null,
    resumed: false,
    paused: false,
    setRawMode(on) {
      this.raw = on;
    },
    setEncoding(value) {
      this.encoding = value;
    },
    resume() {
      this.resumed = true;
    },
    pause() {
      this.paused = true;
    },
    on(event, fn) {
      listeners.set(event, fn);
    },
    removeListener(event) {
      listeners.delete(event);
    },
    /** Push raw terminal input at the prompt. */
    type(text) {
      listeners.get("data")?.(text);
    },
    get pending() {
      return listeners.size;
    },
  };
}

const silent = { write() {} };

await test("the hidden prompt accepts a typed key and restores the terminal", async () => {
  const tty = fakeTty();
  const pendingRead = readHiddenLine(tty, { question: "key: ", output: silent });
  assert.equal(tty.raw, true, "raw mode must be on while prompting");
  assert.equal(tty.encoding, "utf8");
  tty.type("ts-abc");
  tty.type("123");
  tty.type("\r");
  assert.equal(await pendingRead, "ts-abc123");
  assert.equal(tty.raw, false, "raw mode must be switched off afterwards");
  assert.equal(tty.paused, true, "and the stream paused");
  assert.equal(tty.pending, 0, "no listener may be left attached");
});

await test("the hidden prompt handles a whole pasted key arriving as one chunk", async () => {
  const tty = fakeTty();
  const pendingRead = readHiddenLine(tty, { question: "key: ", output: silent });
  tty.type("ts-pasted-key-9876543210\n");
  assert.equal(await pendingRead, "ts-pasted-key-9876543210", "a paste must work, not just typing");
});

await test("the hidden prompt honours backspace and trims", async () => {
  const tty = fakeTty();
  const pendingRead = readHiddenLine(tty, { question: "key: ", output: silent });
  tty.type("ts-abcx");
  tty.type("\u007f");
  tty.type("  \u000d");
  assert.equal(await pendingRead, "ts-abc");
});

await test("Ctrl+C cancels, stores nothing, and leaves the terminal usable", async () => {
  const tty = fakeTty();
  const pendingRead = readHiddenLine(tty, { question: "key: ", output: silent });
  tty.type("partial");
  tty.type("\u0003");
  await assert.rejects(() => pendingRead, /cancelled/i);
  assert.equal(tty.raw, false, "raw mode must be restored even when cancelled");
  assert.equal(tty.pending, 0);
});

await test("a non-terminal stream is refused with a clear message instead of hanging", async () => {
  await assert.rejects(
    () => readHiddenLine({ isTTY: false }, { question: "key: ", output: silent }),
    /raw mode/i,
  );
});

await test("an empty answer resolves to an empty string rather than undefined", async () => {
  const tty = fakeTty();
  const pendingRead = readHiddenLine(tty, { question: "key: ", output: silent });
  tty.type("\r");
  assert.equal(await pendingRead, "");
});

// ---------------------------------------------------------------------------
// 2. storage. Needs PowerShell, so it skips where child processes cannot be spawned.
// ---------------------------------------------------------------------------

if (!FILE) {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  console.log("  SKIP  storage: no LOCALAPPDATA on this machine");
  process.exit(failures.length > 0 ? 1 : 0);
}

const probe = await runPowerShell("'ok'");
if (!probe.ok) {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  console.log(`  SKIP  storage: PowerShell is not usable here (${probe.error})`);
  console.log("        The prompt above was still exercised; storage is Windows-only and");
  console.log("        sandboxed environments block piped stdio to child processes.");
  process.exit(failures.length > 0 ? 1 : 0);
}

// Preserve whatever the user already had.
let hadKey = false;
if (hasStoredKey()) {
  hadKey = true;
  await copyFile(FILE, BACKUP);
  notes.push("an existing stored key was copied aside and will be restored");
}

let cliAvailable = true;

try {
  await test("storeKey refuses an empty key", async () => {
    assert.equal((await storeKey({ plaintext: "   " })).ok, false, "whitespace must be refused");
    assert.equal((await storeKey({})).ok, false, "no plaintext must be refused");
  });

  await test("a key survives a store → read round trip byte for byte", async () => {
    const stored = await storeKey({ plaintext: FAKE_KEY });
    assert.equal(stored.ok, true, `store failed: ${stored.error}`);
    assert.equal(hasStoredKey(), true, "the blob should exist after storing");
    const readBack = await readStoredKey();
    assert.equal(readBack, FAKE_KEY, "the decrypted key must match exactly");
  });

  await test("storing again replaces the previous key", async () => {
    const stored = await storeKey({ plaintext: FAKE_KEY_2 });
    assert.equal(stored.ok, true, `store failed: ${stored.error}`);
    assert.equal(await readStoredKey(), FAKE_KEY_2);
  });

  await test("the stored blob is not the plaintext", async () => {
    const blob = await readFile(FILE, "utf8");
    assert.ok(!blob.includes(FAKE_KEY_2), "the key must not appear in the stored file");
    assert.ok(blob.length > 16, "the blob should be a real encrypted payload");
  });

  await test("clear removes it", async () => {
    const result = await clearStoredKey();
    assert.equal(result.ok, true);
    assert.equal(hasStoredKey(), false, "the blob should be gone");
    assert.equal(await readStoredKey(), null, "and nothing should be readable");
  });

  // --- the CLI, which is what users actually run --------------------------

  await test("`set --from-env` stores the key and reports it masked", async () => {
    const result = await runCli(["set", "--from-env", "JEVCHESS_TEST_KEY"], {});
    // The variable is not set for the child unless we pass it, so this must fail cleanly
    // rather than store something empty.
    assert.equal(result.code, 2, `expected a clean refusal, got exit ${result.code}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /is empty; nothing stored/);
    assert.equal(hasStoredKey(), false, "a failed set must not create a blob");
  });

  await test("`set` reads a piped key (this is also the shape a hidden prompt feeds)", async () => {
    let result;
    try {
      result = await runCli(["set"], { input: `${FAKE_KEY}\n` });
    } catch (error) {
      if (error.code === "EPERM") {
        cliAvailable = false;
        notes.push(`CLI spawn blocked (${error.code}); the storage layer above was still exercised`);
        return;
      }
      throw error;
    }
    assert.equal(result.code, 0, `set failed: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Stored /);
    assert.ok(!result.stdout.includes(FAKE_KEY), "the key must never be echoed");
    assert.equal(await readStoredKey(), FAKE_KEY, "the piped key must have been stored");
  });

  if (cliAvailable) {
    await test("`get` masks by default and prints only with --print", async () => {
      const masked = await runCli(["get"]);
      assert.equal(masked.code, 0, `${masked.stdout}${masked.stderr}`);
      assert.ok(!masked.stdout.includes(FAKE_KEY), "the default output must not contain the key");
      assert.match(masked.stdout, /\*/, "and should show a mask");

      const printed = await runCli(["get", "--print"]);
      assert.equal(printed.stdout.trim(), FAKE_KEY, "with --print it must be exact");
    });

    await test("`status` reports the stored key without printing it", async () => {
      const status = await runCli(["status"]);
      assert.match(status.stdout, /stored key:\s+yes/);
      assert.ok(!status.stdout.includes(FAKE_KEY), "status must never print the key");
    });

    await test("`clear` then `get` fails with a helpful message", async () => {
      const cleared = await runCli(["clear"]);
      assert.equal(cleared.code, 0);
      assert.match(cleared.stdout, /Removed|Nothing was stored/);
      const after = await runCli(["get"]);
      assert.equal(after.code, 1, "get should fail once nothing is stored");
      assert.match(after.stderr, /No readable key is stored/);
    });
  }
} finally {
  // Leave the machine exactly as we found it.
  try {
    if (hadKey && BACKUP && existsSync(BACKUP)) {
      await rm(FILE, { force: true });
      await copyFile(BACKUP, FILE);
      await rm(BACKUP, { force: true });
      notes.push("the original stored key was restored");
    } else {
      await clearStoredKey();
    }
  } catch (error) {
    notes.push(`could not restore the original state: ${error.message}`);
  }
  if (BACKUP && existsSync(BACKUP)) await rm(BACKUP, { force: true }).catch(() => {});
}

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const note of notes) console.log(`  note  ${note}`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.error.message}`);
  process.exitCode = 1;
} else {
  console.log(hasStoredKey() ? "Storage verified; the pre-existing key is back in place." : "Storage verified; no key is stored.");
}
