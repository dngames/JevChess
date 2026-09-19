/**
 * "Is this server really talking to Jev?" — a live check against a running server.
 *
 * The mock provider makes every other test in this project pass, so the one thing that cannot
 * be verified without a key is whether the real integration works: that the request is
 * accepted, that a real model id comes back, that usage is reported, and that the move it
 * chose is legal and carries a full judgement record.
 *
 * Run the server first, then: node tools/real-check.mjs [baseUrl]
 *
 * Exits non-zero if the server is on the mock, if Jev does not answer, or if the record is
 * not complete. Costs one or two Jev requests (well under a cent).
 */

const BASE = (process.argv[2] ?? process.env.JEVCHESS_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

import { Chess } from "../src/engine/chess.js";

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: response.status, json, text };
}

console.log(`Live Jev check against ${BASE}\n`);

// --- 1. the server's own view of its key -----------------------------------

const health = await api("/api/health");
check("the server is reachable", health.status === 200, `status ${health.status}`);
if (health.status !== 200) {
  console.log("\nStart it with `npm start` (and `npm run key:set` first if you have not).");
  process.exit(1);
}

console.log(`  info  model=${health.json.model} hasApiKey=${health.json.hasApiKey} mock=${health.json.mock}`);
check("an API key is loaded", health.json.hasApiKey === true, health.json.hasApiKey ? "" : "run `npm run key:set`, then restart the server");
check("the server is not on the mock provider", health.json.mock === false, health.json.mock ? "this only proves the mock works" : "");

if (health.json.mock) {
  console.log("\nThe server is running mock Jev, so nothing below would prove anything about the real API.");
  process.exit(1);
}

// --- 2. a real Jev move ----------------------------------------------------

const created = await api("/api/games", {
  method: "POST",
  body: {
    mode: "human-vs-jev",
    humanColor: "w",
    players: { b: { strategyId: "balanced" } },
  },
});
check("a game can be created", created.status === 201 && Boolean(created.json?.game?.id), `status ${created.status}`);
const gameId = created.json.game.id;

const humanMove = await api(`/api/games/${gameId}/moves`, { method: "POST", body: { from: "e2", to: "e4" } });
check("the human move is accepted", humanMove.status === 200 && humanMove.json.game.history.length === 1, `status ${humanMove.status}`);

const startedAt = Date.now();
let game = null;
while (Date.now() - startedAt < 90_000) {
  const polled = await api(`/api/games/${gameId}`);
  if (polled.json?.game?.history?.length >= 2) {
    game = polled.json.game;
    break;
  }
  await sleep(500);
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
check("Jev answered within 90 s", Boolean(game), game ? `${seconds} s` : "no reply");
if (!game) {
  console.log("\nThe request may have failed — check the server output for a `[jev]` line.");
  process.exit(1);
}

const move = game.history[1];
const record = move.jev;
check("the reply is recorded as a Jev move", move.by === "jev", `by=${move.by}`);
check("it carries a judgement record", Boolean(record), record ? "" : "no record");
if (!record) process.exit(1);

console.log("\nThe move Jev produced");
console.log(`  move:        ${move.san} (${move.from}→${move.to})`);
console.log(`  model:       ${record.model}`);
console.log(`  pipeline:    ${record.pipeline} (${record.strategyName})`);
console.log(`  candidates:  ${record.candidates.length} scored, chosen at search rank ${record.searchRankOfChosen}`);
console.log(`  requests:    ${record.requests}, tokens: ${record.usage.input_tokens} in / ${record.usage.output_tokens ?? 0} out`);
console.log(`  latency:     ${record.elapsedMs} ms of Jev, ${seconds} s wall clock including the code search`);
console.log(`  confidence:  ${record.candidates.find((candidate) => candidate.chosen)?.choiceProb ?? "n/a"} (choice probability)`);
const dims = record.candidates.find((candidate) => candidate.chosen)?.dims ?? {};
console.log(`  dimensions:  ${Object.entries(dims).map(([key, value]) => `${key}=${value}`).join(", ")}`);
for (const note of record.notes) console.log(`  note:        ${note}`);

check("a real model id came back, not the mock", !/mock/i.test(String(record.model)), `model=${record.model}`);
check("usage was reported", (record.usage?.input_tokens ?? 0) > 0, `${record.usage?.input_tokens} input tokens`);
check("Jev was actually asked", record.requests >= 1, `${record.requests} request(s)`);
check("the move is one of the candidates that were scored", record.candidates.some((candidate) => candidate.chosen), `${record.candidates.filter((candidate) => candidate.chosen).length} marked chosen`);
check("every candidate has a composite score", record.candidates.every((candidate) => typeof candidate.composite === "number"));
check("Jev returned no dimension errors", (record.errors ?? []).length === 0, JSON.stringify(record.errors ?? []));
check("the panel has an explanation", (record.notes ?? []).length > 0);

// Replay the whole recorded game from its start position: the strongest statement that the
// moves really were legal, rather than merely that a FEN string was present.
try {
  const replay = new Chess(game.startFen ?? undefined);
  for (const entry of game.history) replay.move(entry.san);
  check("the recorded game replays move for move", replay.fen() === game.fen, `${game.history.length} plies`);
} catch (error) {
  check("the recorded game replays move for move", false, error.message);
}

const cost = ((record.usage?.input_tokens ?? 0) / 1_000_000) * 0.042;
console.log(`\n  cost of that move: $${cost.toFixed(6)}`);

console.log(
  failures === 0
    ? "\nReal Jev is answering, and the full pipeline works against the live API."
    : `\n${failures} problem(s) — see above.`,
);
process.exit(failures === 0 ? 0 : 1);
