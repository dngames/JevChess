/**
 * Optional Windows secure storage for the TypeSafe API key.
 *
 * A key in `.env` is a key in every backup, every cloud-synced folder and every
 * screenshot of the project. Windows has a built-in, per-user secret store — DPAPI —
 * which PowerShell exposes through `ConvertFrom-SecureString`. This module uses it
 * directly, so there is still no dependency:
 *
 *   %LOCALAPPDATA%\JevChess\jev-key.dpapi   ← DPAPI blob, encrypted for this Windows user
 *
 * Properties that matter:
 *  - the ciphertext can only be decrypted by the same Windows user on the same machine
 *    (a stolen copy of the file is useless elsewhere, unlike a `.env`);
 *  - it lives outside the repository, so it cannot be committed by accident;
 *  - the plaintext never appears on a command line or in the process table: `set` reads
 *    it from a hidden prompt or from an environment variable passed to the child;
 *  - every failure degrades to "no stored key", so a server start can never break
 *    because of it (non-Windows, no PowerShell, no file).
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const DIRECTORY_NAME = "JevChess";
const FILE_NAME = "jev-key.dpapi";
const ENV_SLOT = "JEV_KEY_TO_STORE";

/** Where the encrypted key lives, or null when there is no per-user app data directory. */
export function keyDirectory(env = process.env) {
  const base = env.LOCALAPPDATA || env.APPDATA || null;
  return base ? join(base, DIRECTORY_NAME) : null;
}

export function keyFilePath(env = process.env) {
  const directory = keyDirectory(env);
  return directory ? join(directory, FILE_NAME) : null;
}

/** Is there a stored key? (Does not decrypt anything.) */
export function hasStoredKey(env = process.env) {
  const file = keyFilePath(env);
  return Boolean(file && existsSync(file));
}

/** PowerShell is the crypto primitive here; there is no Node API for DPAPI. */
function powershellExecutable() {
  if (process.platform !== "win32") return null;
  return process.env.JEVCHESS_POWERSHELL || "powershell.exe";
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Run a PowerShell script and capture its output.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, error: string|null}>}
 */
export function runPowerShell(script, { timeoutMs = 20_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const executable = powershellExecutable();
    if (!executable) return resolve({ ok: false, stdout: "", stderr: "", error: "not Windows" });
    let child;
    try {
      child = spawn(
        executable,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...env } },
      );
    } catch (error) {
      return resolve({ ok: false, stdout: "", stderr: "", error: error.message });
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, stdout, stderr, error: `PowerShell timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, error: code === 0 ? null : stderr.trim() || `PowerShell exited ${code}` });
    });
  });
}

/**
 * Decrypt the stored key.
 * @returns {Promise<string|null>} null when there is nothing stored or it cannot be read.
 */
export async function readStoredKey(env = process.env) {
  const file = keyFilePath(env);
  if (!file || !existsSync(file)) return null;
  const script =
    "$ErrorActionPreference = 'Stop'; " +
    `$secure = ConvertTo-SecureString -String (Get-Content -Raw -LiteralPath ${quote(file)}); ` +
    "$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); " +
    "[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)";
  const result = await runPowerShell(script, { env });
  if (!result.ok) return null;
  const key = (result.stdout ?? "").replace(/\r?\n$/, "").trim();
  return key.length > 0 ? key : null;
}

/**
 * Encrypt and store a key.
 *
 * The plaintext is handed to PowerShell through the child's environment, never as an
 * argument, so it does not appear in the process list. The prompting itself lives in the
 * caller (tools/win-key.mjs) and is done in Node: this function previously offered an
 * `interactive` mode that asked PowerShell's `Read-Host` while spawning it with
 * `-NonInteractive`, which cannot work — that is the bug the first user of `npm run key:set`
 * hit, and the reason this is now a single, exercised path.
 *
 * @param {{plaintext: string}} options
 */
export async function storeKey({ plaintext } = {}) {
  const file = keyFilePath();
  const directory = keyDirectory();
  if (!file || !directory) {
    return { ok: false, error: "No LOCALAPPDATA on this machine; use .env instead." };
  }
  if (!powershellExecutable()) {
    return { ok: false, error: "Windows secure storage needs Windows with PowerShell; use .env instead." };
  }
  if (typeof plaintext !== "string" || plaintext.trim().length === 0) {
    return { ok: false, error: "Nothing to store." };
  }

  const script =
    "$ErrorActionPreference = 'Stop'; " +
    `New-Item -ItemType Directory -Force -Path ${quote(directory)} | Out-Null; ` +
    `$secure = ConvertTo-SecureString -String $env:${ENV_SLOT} -AsPlainText -Force; ` +
    `ConvertFrom-SecureString -SecureString $secure | Set-Content -NoNewline -LiteralPath ${quote(file)}; ` +
    "'stored'";
  const result = await runPowerShell(script, { env: { [ENV_SLOT]: plaintext } });
  if (!result.ok) return { ok: false, error: result.error ?? "PowerShell failed" };
  return { ok: true, file };
}

/** Remove the stored key. */
export async function clearStoredKey(env = process.env) {
  const file = keyFilePath(env);
  if (!file || !existsSync(file)) return { ok: true, removed: false };
  await rm(file, { force: true });
  return { ok: true, removed: true };
}

/**
 * Resolve the key the way the server does: environment/`.env` first, then Windows
 * secure storage. Returns the key plus a description safe to log.
 */
export async function resolveApiKey(env = process.env) {
  const fromEnv = (env.TYPESAFE_API_KEY ?? "").trim();
  if (fromEnv) return { key: fromEnv, source: "TYPESAFE_API_KEY (environment or .env)", stored: false };
  if (hasStoredKey(env)) {
    const key = await readStoredKey(env);
    if (key) return { key, source: `Windows secure storage (${keyFilePath(env)})`, stored: true };
    return { key: "", source: "a stored key exists but could not be read (use .env instead)", stored: true, failed: true };
  }
  return { key: "", source: "not set", stored: false };
}
