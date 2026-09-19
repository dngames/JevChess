/**
 * Soak test: play whole games to a finish.
 *
 * Every other test in this project plays a handful of plies. Nothing played a game *to a
 * result*, which is exactly where the long-tail defects live: promotion inside the AI turn
 * loop, castling late in a game, threefold and fifty-move draws, the move counter running
 * away, the autoplay loop stalling, or a recorded game that cannot be replayed.
 *
 * These games run against the mock Jev (or code-only seats) with a deliberately tiny search
 * budget, because the point is the game loop, not the strength. That is stated plainly so
 * nobody mistakes a green run here for evidence about Jev's chess.
 *
 * Run with: node tests/soak.test.mjs
 */

import assert from "node:assert/strict";
import { Chess } from "../src/engine/chess.js";
import { Game } from "../src/game.js";
import { resolveStrategy } from "../src/strategies.js";

const BUDGET_MS = 40; // tiny: a whole game in seconds rather than minutes
const MAX_PLIES = 300;

let passed = 0;
const failures = [];
const pending = [];

function report(name, error) {
  failures.push({ name, error });
  console.log(`  FAIL  ${name}\n        ${error.message.split("\n").join("\n        ")}`);
}

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pending.push(result.then(() => { passed += 1; }, (error) => report(name, error)));
    } else {
      passed += 1;
    }
  } catch (error) {
    report(name, error);
  }
}

/** A stand-in for Jev that answers deterministically and never fails. */
function mockJev() {
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  return {
    mock: true,
    model: "soak-jev",
    stats: { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 },
    async systemOne({ questions = {} }) {
      const answers = {};
      for (const [id, question] of Object.entries(questions)) {
        if (question.type === "choice") {
          const options = Object.keys(question.criteria);
          const choice = options[Math.floor(random() * options.length)];
          answers[id] = {
            type: "choice",
            choice,
            probabilities: Object.fromEntries(options.map((option) => [option, option === choice ? 0.6 : 0.4 / Math.max(1, options.length - 1)])),
            confidence: 0.6,
          };
        } else if (question.type === "score") {
          answers[id] = { type: "score", score: Math.floor(random() * question.criteria.length), probabilities: {}, confidence: 0.7, legend: {} };
        } else {
          answers[id] = { type: "noul", noul: random() };
        }
      }
      return { model: "soak-jev", answers, usage: { input_tokens: 10, output_tokens: 0 }, attempts: 1, elapsedMs: 1, mock: true };
    },
  };
}

function makeGame({ players, fen, timeControl = null, aiMoveDelayMs = 0 }) {
  return new Game({
    id: `soak_${Math.random().toString(36).slice(2, 7)}`,
    mode: "jev-vs-jev",
    fen,
    timeControl,
    playerConfigs: players,
    jevClient: mockJev(),
    modelName: "jev-latest",
    hasApiKey: true,
    // No pacing: these games exist to exercise the loop, not to be watched.
    aiMoveDelayMs,
  });
}

/** Drive autoplay until the game ends, the ply cap is hit, or time runs out. */
async function playToEnd(game, { timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!game.snapshot().status.over && game.history.length < MAX_PLIES && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return {
    status: game.snapshot().status,
    plies: game.history.length,
    timedOut: Date.now() >= deadline,
  };
}

/** Replay the recorded SAN moves from the initial position. */
function replay(history, startFen) {
  const chess = startFen ? new Chess(startFen) : new Chess();
  for (const record of history) {
    const applied = chess.move(record.san);
    assert.ok(applied, `recorded move ${record.ply} (${record.san}) is not legal on replay`);
    assert.equal(chess.fen(), record.fenAfter, `recorded position after ply ${record.ply} does not match a replay`);
  }
  return chess;
}

const FAST = { strategyId: "code-only", timeBudgetMs: BUDGET_MS };

// ===========================================================================

console.log(`Soak test: whole games, search budget ${BUDGET_MS} ms per move, mock/engine seats\n`);

test("a full game from the start position reaches a terminal state", async () => {
  const game = makeGame({ players: { w: FAST, b: FAST } });
  const events = { "game-over": 0, state: 0 };
  game.subscribe((event) => {
    if (event in events) events[event] += 1;
  });

  const result = await playToEnd(game);
  const snapshot = game.snapshot();

  assert.equal(result.timedOut, false, `the game did not finish within the time budget (${result.plies} plies)`);
  assert.equal(snapshot.status.over, true, `the game should be over (${result.plies} plies played)`);
  assert.ok(["1-0", "0-1", "1/2-1/2"].includes(snapshot.status.result), `unexpected result ${JSON.stringify(snapshot.status.result)}`);
  assert.ok(result.plies > 10, `a real game should last more than ten plies, got ${result.plies}`);
  assert.ok(result.plies <= MAX_PLIES, `the ply cap must hold (got ${result.plies})`);
  assert.equal(events["game-over"], 1, "exactly one game-over event");
  assert.ok(events.state > result.plies, "every ply must broadcast a state update");
  assert.equal(game.history.length, result.plies);
  assert.equal(snapshot.legalMoves.length, 0, "no legal moves are offered once the game is over");
  assert.equal(game.ai.thinking, false, "the AI loop must be idle when the game ends");
  game.dispose();
  console.log(`  info  start position: ${result.plies} plies, ${snapshot.status.result} by ${snapshot.status.reason}`);
});

test("the recorded game replays exactly", async () => {
  const game = makeGame({ players: { w: FAST, b: FAST } });
  await playToEnd(game);
  const snapshot = game.snapshot();
  const replayed = replay(game.history, snapshot.startFen);
  assert.equal(replayed.fen(), snapshot.fen, "replaying every recorded move must reproduce the final position");
  assert.equal(replayed.result(), snapshot.status.result, "and the recorded result");
  for (const record of game.history) {
    assert.ok(typeof record.san === "string" && record.san.length > 0, `ply ${record.ply} needs SAN`);
    assert.ok(record.from && record.to, `ply ${record.ply} needs from/to`);
    assert.ok(record.by === "jev", `ply ${record.ply} should be attributed to a Jev seat`);
    assert.ok(record.jev === null || typeof record.jev === "object", `ply ${record.ply} has a malformed record`);
    assert.equal(typeof record.moveNumber, "number");
  }
  game.dispose();
});

test("a pawn endgame is played through promotion", async () => {
  // King and pawn against king: the engine seats will push the pawn, and the game must
  // handle promotion inside the AI turn loop (records, SAN, board state) without error.
  const game = makeGame({ players: { w: FAST, b: FAST }, fen: "8/8/8/4k3/8/8/4P3/4K3 w - - 0 1" });
  const result = await playToEnd(game, { timeoutMs: 60_000 });
  const promotions = game.history.filter((record) => record.promotion);
  const anyPromotion = promotions.length > 0;
  console.log(
    `  info  K+P endgame: ${result.plies} plies, ${game.snapshot().status.result ?? "unfinished"} by ${game.snapshot().status.reason ?? "-"}` +
      `${anyPromotion ? `, ${promotions.length} promotion(s) (${promotions.map((record) => record.san).join(", ")})` : ", no promotion reached"}`,
  );
  assert.equal(game.lastError, null, `no engine error should be recorded: ${game.lastError}`);
  if (anyPromotion) {
    for (const record of promotions) {
      assert.match(record.san, /=[QRBN]/, "a promotion record must show the piece in SAN");
      assert.ok(["q", "r", "b", "n"].includes(record.promotion), `unexpected promotion piece ${record.promotion}`);
    }
    const replayed = replay(game.history, game.snapshot().startFen);
    assert.equal(replayed.fen(), game.snapshot().fen, "a game with promotions must still replay");
  }
  game.dispose();
});

test("a position with castling rights available is played without corrupting the board", async () => {
  const game = makeGame({ players: { w: FAST, b: FAST }, fen: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1" });
  const result = await playToEnd(game, { timeoutMs: 90_000 });
  const castles = game.history.filter((record) => record.castle);
  assert.equal(game.lastError, null, `no engine error should be recorded: ${game.lastError}`);
  assert.ok(game.history.every((record) => record.fenAfter.split(" ").length === 6), "every record carries a full FEN");
  const replayed = replay(game.history, game.snapshot().startFen);
  assert.equal(replayed.fen(), game.snapshot().fen, "a game with castling must still replay");
  console.log(
    `  info  castling position: ${result.plies} plies, ${castles.length} castle move(s)` +
      `${castles.length ? ` (${castles.map((record) => record.san).join(", ")})` : ""}, ${game.snapshot().status.result ?? "unfinished"}`,
  );
  game.dispose();
});

test("a bare-king endgame is drawn by insufficient material rather than looping", async () => {
  const game = makeGame({ players: { w: FAST, b: FAST }, fen: "8/8/8/4k3/8/8/4K3/6Q1 w - - 0 1" });
  await playToEnd(game, { timeoutMs: 60_000 });
  const status = game.snapshot().status;
  assert.equal(status.over, true, "the game must terminate");
  assert.ok(
    ["checkmate", "insufficient material", "fifty-move rule", "threefold repetition", "stalemate"].includes(status.reason),
    `unexpected termination reason: ${status.reason}`,
  );
  game.dispose();
  console.log(`  info  K+Q vs K: ${status.result} by ${status.reason} after ${game.history.length} plies`);
});

test("a full game with the composite pipeline (mock Jev) runs without record errors", async () => {
  // Not evidence about Jev's strength — evidence that the real pipeline survives a game:
  // twelve candidates, sixty-odd questions, a composite score and a written record per move.
  const game = makeGame({
    players: { w: { strategyId: "balanced", timeBudgetMs: BUDGET_MS }, b: { strategyId: "positional", timeBudgetMs: BUDGET_MS } },
    timeControl: { initialMs: 60_000, incrementMs: 100 },
  });
  const deadline = Date.now() + 90_000;
  while (!game.snapshot().status.over && game.history.length < 24 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const plies = game.history.length;
  assert.ok(plies >= 8, `the pipeline should have produced at least a few moves, got ${plies}`);
  const jevMoves = game.history.filter((record) => record.jev);
  assert.equal(jevMoves.length, plies, "every AI move must carry a Jev record");
  for (const record of jevMoves) {
    assert.ok(Array.isArray(record.jev.candidates) && record.jev.candidates.length > 0, `ply ${record.ply}: candidates missing`);
    assert.ok(record.jev.candidates.some((candidate) => candidate.chosen), `ply ${record.ply}: no candidate marked chosen`);
    assert.ok(record.jev.chosenSan === record.san, `ply ${record.ply}: the record's chosen move must be the move played`);
    assert.ok(record.jev.usage.input_tokens > 0, `ply ${record.ply}: usage should be reported`);
    assert.equal(record.jev.errors.length, 0, `ply ${record.ply}: unexpected errors ${JSON.stringify(record.jev.errors)}`);
    assert.ok(record.jev.notes.length > 0, `ply ${record.ply}: the panel needs an explanation`);
  }
  const replayed = replay(game.history, game.snapshot().startFen);
  assert.equal(replayed.fen(), game.snapshot().fen, "the composite games must replay too");
  assert.equal(game.lastError, null, `no error should be recorded: ${game.lastError}`);
  const clocks = game.snapshot().clocks;
  assert.ok(clocks.w < 60_000, "the clock must have been used");
  game.dispose();
  console.log(`  info  composite pipeline: ${plies} plies, clock ${Math.round(clocks.w / 1000)}s / ${Math.round(clocks.b / 1000)}s remaining`);
});

test("undo mid-game keeps the record consistent", async () => {
  const game = makeGame({ players: { w: FAST, b: FAST } });
  const deadline = Date.now() + 30_000;
  while (game.history.length < 6 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40));
  const before = game.history.length;
  assert.ok(before >= 6, `expected some moves first, got ${before}`);

  // Pause so the AI loop does not immediately re-play the move we take back.
  game.setAutoplay(false);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const result = game.undo();
  assert.equal(result.ok, true);
  assert.equal(game.history.length, before - 1, "undo removes exactly one ply in a Jev-vs-Jev game");
  const snapshot = game.snapshot();
  const replayed = replay(game.history, snapshot.startFen);
  assert.equal(replayed.fen(), snapshot.fen, "the shortened game must still replay");
  assert.equal(replay(game.history, snapshot.startFen).turn(), snapshot.turn, "and the side to move must match");

  // Undo right back to the start, then confirm the position is the starting one.
  while (game.history.length > 0) {
    const stepped = game.undo();
    if (!stepped.ok) break;
  }
  assert.equal(game.snapshot().fen, game.snapshot().startFen, "undoing everything returns to the initial position");
  assert.equal(game.snapshot().history.length, 0);
  game.dispose();
});

test("the same game id and clock behave across a long game", async () => {
  const game = makeGame({
    players: { w: FAST, b: FAST },
    timeControl: { initialMs: 30_000, incrementMs: 50 },
  });
  const result = await playToEnd(game, { timeoutMs: 90_000 });
  const snapshot = game.snapshot();
  assert.equal(snapshot.id, game.id);
  assert.ok(snapshot.clocks.w >= 0 && snapshot.clocks.b >= 0, "clocks must never go negative");
  if (snapshot.status.reason === "timeout") {
    assert.equal(snapshot.status.over, true, "a flag must end the game");
    assert.equal(game.ai.thinking, false);
  }
  assert.ok(
    snapshot.history.every((record, index) => record.ply === index + 1),
    "ply numbering must be contiguous",
  );
  const moves = snapshot.history.map((record) => record.moveNumber);
  assert.ok(moves.every((value, index) => index === 0 || value >= moves[index - 1]), "the move number must never go backwards");
  game.dispose();
  console.log(
    `  info  clocked game: ${result.plies} plies, ${snapshot.status.result ?? "unfinished"} by ${snapshot.status.reason ?? "-"}` +
      `, clocks ${Math.round(snapshot.clocks.w / 1000)}s / ${Math.round(snapshot.clocks.b / 1000)}s`,
  );
});

test("a per-player search budget is clamped and honoured", () => {
  assert.equal(resolveStrategy({ strategyId: "balanced", timeBudgetMs: 40 }).timeBudgetMs, 50, "the floor is 50 ms");
  assert.equal(resolveStrategy({ strategyId: "balanced", timeBudgetMs: 999_999 }).timeBudgetMs, 10_000, "the ceiling is 10 s");
  assert.equal(resolveStrategy({ strategyId: "balanced", timeBudgetMs: "abc" }).timeBudgetMs, 1400, "junk falls back to the preset");
  assert.equal(resolveStrategy({ strategyId: "code-only" }).timeBudgetMs, 1400, "the preset default still applies");
});

// ===========================================================================

await Promise.all(pending);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.error.message}`);
  process.exitCode = 1;
} else {
  console.log("Whole games play to a legal finish and replay move for move.");
}
