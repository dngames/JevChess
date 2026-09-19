/**
 * Read a secret from a terminal with echo off.
 *
 * Extracted from tools/win-key.mjs so it can be unit-tested with a fake stream: a real TTY is
 * not available in every environment, and this is the exact code that runs when a person
 * pastes their API key. It handles the two things that actually happen in practice — a key
 * arriving one character at a time, and a whole pasted key arriving as a single chunk.
 *
 * Nothing is echoed, not even a mask, so a pasted key cannot be read off the screen.
 */

/**
 * @param {NodeJS.ReadStream & { setRawMode?: (on: boolean) => void }} input
 * @param {{question?: string, output?: {write: (text: string) => void}}} [options]
 * @returns {Promise<string>} the trimmed value, or a rejection when the user cancels
 */
export function readHiddenLine(input, { question = "", output = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    if (!input || typeof input.setRawMode !== "function") {
      reject(new Error("this stream cannot be read in raw mode (not a terminal)"));
      return;
    }

    let value = "";
    let settled = false;

    const finish = (error) => {
      if (settled) return undefined;
      settled = true;
      input.setRawMode(false);
      input.pause?.();
      input.removeListener("data", onData);
      if (question) output.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
      return undefined;
    };

    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n" || character === "\u0004") return finish();
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
      return undefined;
    };

    if (question) output.write(question);
    input.setRawMode(true);
    input.resume?.();
    input.setEncoding?.("utf8");
    input.on("data", onData);
  });
}
