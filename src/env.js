/**
 * Minimal .env loading. Deliberately not a dependency: a handful of lines that
 * understand `KEY=value`, `#` comments and optional surrounding quotes.
 *
 * Existing process.env values always win, so `TYPESAFE_API_KEY=... npm start`
 * overrides the file.
 */
import { readFileSync, existsSync } from "node:fs";

export function loadDotEnv(path) {
  const loaded = {};
  if (!path || !existsSync(path)) return loaded;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return loaded;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
      loaded[key] = value;
    }
  }
  return loaded;
}

/** Where the key comes from, without ever revealing it. */
export function describeApiKey(apiKey) {
  if (!apiKey) return "not set";
  return `set (${apiKey.length} characters, ends "${apiKey.slice(-4)}")`;
}
