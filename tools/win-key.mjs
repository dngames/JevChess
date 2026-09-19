/**
 * Manage the TypeSafe API key in Windows secure storage (DPAPI, per Windows user).
 *
 *   node tools/win-key.mjs status                  # is a key stored, and where
 *   node tools/win-key.mjs set                     # hidden prompt in this terminal
 *   node tools/win-key.mjs set --from-env VAR      # take it from an environment variable
 *   node tools/win-key.mjs get [--print]           # confirm what is stored (masked by default)
 *   node tools/win-key.mjs clear                   # delete the stored key
 *
 * The prompt is implemented here in Node, not in PowerShell. The first version asked
 * PowerShell's `Read-Host` while spawning it with `-NonInteractive` — a combination that can
 * never work — so `set` failed for anyone who tried it. Node reads the keys in raw mode with
 * echo off, and PowerShell is left with only the job it is actually good for here: encrypting
 * with DPAPI. That keeps a single, tested storage path.
 *
 * The key is never echoed, never printed unless you ask with --print, and never appears on a
 * command line or in the process list.
 */

import { clearStoredKey, hasStoredKey, keyFilePath, readStoredKey, storeKey } from "../src/win-key.js";
import { readHiddenLine } from "./hidden-prompt.mjs";

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

/** Read a key that was piped into stdin, e.g. `Get-Content key.txt | node tools/win-key.mjs set`. */
async function readPipedStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const value = Buffer.concat(chunks).toString("utf8").trim();
  return value.length > 0 ? value : null;
}

async function store(value, how) {
  const result = await storeKey({ plaintext: value });
  if (!result.ok) {
    console.error(`Could not store the key: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Stored ${mask(value)} in ${result.file}`);
  console.log(`Encrypted for this Windows user only; readable with \`npm run key:status\`.`);
  console.log(`Restart the server to use it (${how}).`);
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
      await store(value, `${name} was read and can now be unset`);
      break;
    }

    const piped = await readPipedStdin();
    if (piped) {
      await store(piped, "piped input was used");
      break;
    }

    if (!process.stdin.isTTY) {
      console.error("This terminal is not interactive, so there is nothing to prompt.");
      console.error("Alternatives: `npm run key:set -- --from-env TYPESAFE_API_KEY`, pipe the key in, or use .env");
      process.exitCode = 2;
      break;
    }

    try {
      const typed = await readHiddenLine(process.stdin, {
        question: "Paste the TypeSafe API key, then press Enter (input is hidden): ",
      });
      if (!typed) {
        console.error("Nothing entered; nothing stored.");
        process.exitCode = 2;
        break;
      }
      await store(typed, "the prompt read it");
    } catch (error) {
      console.error(`Could not read the key: ${error.message}`);
      console.error("Alternatives: `npm run key:set -- --from-env TYPESAFE_API_KEY`, or put TYPESAFE_API_KEY in .env");
      process.exitCode = 1;
    }
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
