/**
 * Manage the TypeSafe API key in Windows secure storage (DPAPI, per Windows user).
 *
 *   node tools/win-key.mjs status                  # is a key stored, and where
 *   node tools/win-key.mjs set                     # hidden interactive prompt
 *   node tools/win-key.mjs set --from-env VAR      # read from an environment variable
 *   node tools/win-key.mjs get [--print]           # confirm what is stored (masked by default)
 *   node tools/win-key.mjs clear                   # delete the stored key
 *
 * The key is never printed unless you ask with --print, and never appears on a command
 * line or in the process list: `set` reads it from a hidden prompt or from the child's
 * environment, and PowerShell encrypts it with DPAPI before it touches the disk.
 */

import { clearStoredKey, hasStoredKey, keyFilePath, readStoredKey, storeKey } from "../src/win-key.js";

const [command, ...rest] = process.argv.slice(2);
const file = keyFilePath();

function mask(key) {
  if (!key) return "(empty)";
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 3)}…${"*".repeat(Math.max(4, key.length - 7))}${key.slice(-4)} (${key.length} characters)`;
}

function usage() {
  console.log(`Usage:
  node tools/win-key.mjs status
  node tools/win-key.mjs set [--from-env VARIABLE]
  node tools/win-key.mjs get [--print]
  node tools/win-key.mjs clear

Storage: ${file ?? "(no LOCALAPPDATA on this machine)"}
The blob is encrypted for the current Windows user and lives outside the repository.`);
}

switch (command) {
  case "status": {
    console.log(`storage file: ${file ?? "(unavailable)"}`);
    console.log(`stored key:   ${hasStoredKey() ? "yes" : "no"}`);
    if (hasStoredKey()) {
      const key = await readStoredKey();
      console.log(`readable:     ${key ? `yes — ${mask(key)}` : "no (different Windows user or damaged file)"}`);
    }
    if ((process.env.TYPESAFE_API_KEY ?? "").trim()) {
      console.log("note:         TYPESAFE_API_KEY is also set in the environment/.env, which takes precedence");
    }
    break;
  }

  case "set": {
    const envFlag = rest.indexOf("--from-env");
    if (envFlag >= 0) {
      const name = rest[envFlag + 1];
      if (!name) {
        console.error("--from-env needs a variable name, e.g. --from-env TYPESAFE_API_KEY");
        process.exitCode = 2;
        break;
      }
      const value = (process.env[name] ?? "").trim();
      if (!value) {
        console.error(`${name} is empty; nothing stored.`);
        process.exitCode = 2;
        break;
      }
      const result = await storeKey({ plaintext: value });
      if (!result.ok) {
        console.error(`Could not store the key: ${result.error}`);
        process.exitCode = 1;
        break;
      }
      console.log(`Stored ${mask(value)} in ${result.file}`);
      break;
    }
    const result = await storeKey({ interactive: true });
    if (!result.ok) {
      console.error(`Could not store the key: ${result.error}`);
      process.exitCode = 1;
      break;
    }
    console.log(`Stored in ${result.file} (encrypted for this Windows user only).`);
    break;
  }

  case "get": {
    const key = await readStoredKey();
    if (!key) {
      console.error("No readable key is stored. Use `set` first, or put TYPESAFE_API_KEY in .env.");
      process.exitCode = 1;
      break;
    }
    console.log(rest.includes("--print") ? key : mask(key));
    break;
  }

  case "clear": {
    const result = await clearStoredKey();
    console.log(result.removed ? `Removed ${file}` : "Nothing was stored.");
    break;
  }

  default:
    usage();
    if (command) process.exitCode = 2;
}
