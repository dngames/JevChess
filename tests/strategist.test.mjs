/**
 * The strategy layer inside a real game loop.
 *
 * `llm-plan.test.mjs` tests the layer in isolation; this proves it is actually wired in: that a
 * planning seat gets a plan, that the plan reaches the move record and the scoring weights, that
 * plans are *cached* rather than re-requested every move (the main cost lever), and that a broken
 * strategist degrades to the preset without stopping the game.
 *
 * Jev and the strategist are both mocked here, because the point is the plumbing, not the chess.
 * With a real key, `npm run selfplay -- --a=strategist --b=balanced --games=20` measures whether
 * the plan layer is actually worth its latency.
 *
 * Run with: node tests/strategist.test.mjs
 */

import assert from "node:assert/strict";

import { Game } from "../src/game.js";
import { MockLlmClient } from "../src/llm/client.js";
import { EVAL_SWING_CP, shouldReview } from "../src/llm/strategist.js";

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

/** A Jev that always answers plausibly and never fails. */
function mockJev() {
  let seed = 987654321;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  return {
    mock: true,
    model: "mock-jev",
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
            probabilities: Object.fromEntries(options.map((option) => [option, option === choice ? 0.7 : 0.3 / Math.max(1, options.length - 1)])),
            confidence: 0.7,
          };
        } else if (question.type === "score") {
          answers[id] = { type: "score", score: Math.floor(random() * question.criteria.length), probabilities: {}, confidence: 0.6, legend: {} };
        } else {
          answers[id] = { type: "noul", noul: random() };
        }
      }
      return { model: "mock-jev", answers, usage: { input_tokens: 120, output_tokens: 12 }, attempts: 1, elapsedMs: 1, mock: true };
    },
  };
}

const BUDGET_MS = 40;

function makeGame({ players, llmClient, fen, timeControl = null }) {
  return new Game({
    id: `plan_${Math.random().toString(36).slice(2, 7)}`,
    mode: "jev-vs-jev",
    fen,
    timeControl,
    playerConfigs: players,
    jevClient: mockJev(),
    llmClient,
    modelName: "jev-latest",
    hasApiKey: true,
    // A non-zero pacing matters more than it looks: with 0 the AI loop runs as a microtask chain
    // (the mock Jev and the search resolve without ever needing a timer), so it never yields to the
    // timer queue and a polling test loop only sees the game once it is over. That is harmless in
    // the server, where I/O yields constantly, but it made this suite report ply counts far above
    // what it asked for. One millisecond per AI move restores fairness.
    aiMoveDelayMs: 1,
  });
}

/**
 * Play until `count` plies have been made, then pause the game so it stops growing — otherwise the
 * assertions race a game that keeps playing (which is what made the first version of this file
 * report ply counts far above what it asked for, and slow the suite down badly).
 */
async function playPlies(game, count, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (game.snapshot().status.over) break;
    if (game.history.length >= count) {
      game.setAutoplay(false);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return game.history.length;
}

const SEAT = (id) => ({ strategyId: id, timeBudgetMs: BUDGET_MS });

// ===========================================================================
// 1. the trigger policy, in isolation
// ===========================================================================

console.log("\n== review triggers ==");

const PLAN = { plan: "minority_attack", targets: ["c5"], risk: "balanced", reviewAfterPlies: 5, weightDeltas: {}, askJev: [] };

test("no plan means a review is due", () => {
  const verdict = shouldReview({ plan: null });
  assert.equal(verdict.review, true);
  assert.equal(verdict.reason, "no-plan");
});

test("a fresh plan is left alone", () => {
  const verdict = shouldReview({ plan: PLAN, pliesSinceReview: 2, evalCp: 20, planEvalCp: 10, phase: "middlegame", planPhase: "middlegame" });
  assert.equal(verdict.review, false);
  assert.equal(verdict.reason, "plan-still-valid");
});

test("a plan past its review interval is re-examined, cheaply", () => {
  const verdict = shouldReview({ plan: PLAN, pliesSinceReview: 5 });
  assert.equal(verdict.review, true);
  assert.equal(verdict.reason, "plan-expired");
  assert.equal(verdict.thinkingLevel, "low", "routine reviews must not pay for deep thinking");
});

test("a phase change is a normal-priority review", () => {
  const verdict = shouldReview({ plan: PLAN, pliesSinceReview: 1, phase: "endgame", planPhase: "middlegame" });
  assert.equal(verdict.reason, "phase-change");
  assert.equal(verdict.thinkingLevel, "medium");
});

test("the opponent landing on a target is a crisis", () => {
  const verdict = shouldReview({ plan: PLAN, pliesSinceReview: 1, targetTouched: true });
  assert.equal(verdict.reason, "plan-broken");
  assert.equal(verdict.thinkingLevel, "high");
});

test("a large assessment swing is a crisis, a small one is not, and noise early on is ignored", () => {
  assert.equal(shouldReview({ plan: PLAN, pliesSinceReview: 4, evalCp: 300, planEvalCp: 20 }).reason, "eval-swing");
  assert.equal(shouldReview({ plan: PLAN, pliesSinceReview: 4, evalCp: 20 + EVAL_SWING_CP - 1, planEvalCp: 20 }).review, false);
  // The measurement that produced these numbers: at 150cp with no gate, the swing trigger fired on
  // almost every move, because a depth-2 evaluation of a quiet position moves by 50-100cp anyway.
  assert.equal(
    shouldReview({ plan: PLAN, pliesSinceReview: 1, evalCp: 400, planEvalCp: 20 }).review,
    false,
    "a swing immediately after a review must not trigger another one",
  );
});

test("a forced review overrides everything", () => {
  const verdict = shouldReview({ plan: PLAN, pliesSinceReview: 0, forced: true });
  assert.equal(verdict.review, true);
  assert.equal(verdict.reason, "forced");
});

// ===========================================================================
// 2. in a real game loop
// ===========================================================================

console.log("\n== in a game loop ==");

await test("a planning seat records a validated plan on its moves", async () => {
  const llm = new MockLlmClient();
  const game = makeGame({ players: { w: SEAT("strategist"), b: SEAT("strategist") }, llmClient: llm });
  const plies = await playPlies(game, 8);
  assert.ok(plies >= 6, `expected some moves, got ${plies}`);

  const jevMoves = game.history.filter((entry) => entry.jev);
  assert.ok(jevMoves.length > 0);
  for (const entry of jevMoves) {
    assert.ok(entry.jev.llm, `ply ${entry.ply} should carry a plan`);
    assert.equal(entry.jev.llm.enabled, true);
    assert.ok(entry.jev.llm.plan, `ply ${entry.ply} has no plan object`);
    assert.ok(typeof entry.jev.llm.plan.plan === "string", "the plan names a plan kind");
    assert.ok(entry.jev.llm.promptVersion, "the record says which prompt produced it");
    assert.equal(entry.jev.llm.mock, true, "a mock plan must be labelled as one");
    assert.ok(entry.jev.llm.applied, "the record says what the plan changed");
  }
  game.dispose();
});

await test("plans are cached: the strategist is called at the interval the plan asks for", async () => {
  // A stub that asks for a review every eight plies and never changes its story, so the call count
  // measures the cache rather than the mock's randomness.
  const calls = [];
  const stub = {
    mock: false,
    provider: "test",
    model: "stub",
    async generateJson() {
      calls.push(Date.now());
      const json = { plan: "improve_pieces", targets: [], risk: "balanced", review_after_plies: 8, commentary: "steady as she goes" };
      return {
        ok: true,
        json,
        text: JSON.stringify(json),
        usage: { inputTokens: 100, outputTokens: 10, thoughtTokens: 0 },
        costUsd: 0.0001,
        attempts: 1,
        elapsedMs: 1,
        notes: [],
      };
    },
  };
  const game = makeGame({ players: { w: SEAT("strategist"), b: SEAT("strategist") }, llmClient: stub });
  const plies = await playPlies(game, 32, { timeoutMs: 180_000 });
  assert.ok(plies >= 30, `expected thirty plies, got ${plies}`);

  // The cost claim is a rate, not an absolute cap: each seat's plan asks for a review every eight
  // plies, and an eval swing may legitimately add one or two on top. What must hold is that the
  // strategist is called far less often than once per ply.
  const perPly = calls.length / plies;
  assert.ok(calls.length < plies, `caching must mean fewer calls (${calls.length}) than plies (${plies})`);
  assert.ok(perPly <= 0.5, `expected at most one call per two plies, got ${perPly.toFixed(2)} (${calls.length} calls / ${plies} plies)`);
  assert.equal(game.snapshot().llm.reviews, calls.length, "the snapshot's review count matches the calls actually made");
  game.dispose();
  console.log(`  info  ${calls.length} strategist calls for ${plies} plies (one per ${(plies / calls.length).toFixed(1)} plies)`);
});

await test("the plan reaches the scoring weights and the snapshot exposes it", async () => {
  const llm = new MockLlmClient();
  const game = makeGame({ players: { w: SEAT("strategist"), b: SEAT("balanced") }, llmClient: llm });
  await playPlies(game, 6);
  const snapshot = game.snapshot();

  assert.equal(snapshot.llm.configured, true);
  assert.equal(snapshot.llm.provider, "mock");
  assert.ok(typeof snapshot.llm.costUsd === "number");
  const planned = snapshot.history.find((entry) => entry.jev?.llm);
  assert.ok(planned, "at least one move should have played under a plan");
  assert.ok(planned.jev.weights, "the record carries the weights that decided the move");
  const total = Object.values(planned.jev.weights).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, "the weights in force must be normalised");

  // White plans, Black does not — so one side's records carry a plan and the other's do not.
  const whiteMoves = snapshot.history.filter((entry) => entry.color === "w" && entry.jev);
  const blackMoves = snapshot.history.filter((entry) => entry.color === "b" && entry.jev);
  assert.ok(whiteMoves.every((entry) => entry.jev.llm), "the strategist seat carries plans");
  assert.ok(blackMoves.every((entry) => entry.jev.llm === null), "the balanced seat must not");
  assert.equal(snapshot.players.w.usesStrategist, true);
  assert.equal(snapshot.players.b.usesStrategist, false);
  game.dispose();
});

await test("a planning seat with no strategist configured falls back and says so", async () => {
  const game = makeGame({ players: { w: SEAT("strategist"), b: SEAT("balanced") }, llmClient: null });
  const plies = await playPlies(game, 4);
  assert.ok(plies >= 4, "the game must still play");
  const snapshot = game.snapshot();
  assert.equal(snapshot.llm.configured, false);
  assert.match(String(snapshot.llm.lastError), /not configured/);
  const move = snapshot.history.find((entry) => entry.color === "w" && entry.jev);
  assert.equal(move.jev.llm, null, "no plan object when there is no plan");
  assert.ok(move.jev.notes.some((note) => /not configured|No plan/.test(note)), `expected an explanation, got: ${move.jev.notes.join(" | ")}`);
  game.dispose();
});

await test("a broken strategist degrades to the preset without stopping the game", async () => {
  let calls = 0;
  const failing = {
    mock: false,
    provider: "gemini",
    model: "gemini-3.8-flash",
    async generateJson() {
      calls += 1;
      return { ok: false, error: "Gemini is overloaded", code: "gemini-overloaded", attempts: 3, elapsedMs: 5, notes: [], usage: null, costUsd: null };
    },
  };
  const game = makeGame({ players: { w: SEAT("strategist"), b: SEAT("balanced") }, llmClient: failing });
  const plies = await playPlies(game, 6);
  const snapshot = game.snapshot();

  assert.ok(plies >= 6, `the game must keep playing after a strategist failure, got ${plies}`);
  assert.ok(calls > 0, "the strategist was actually tried");
  assert.match(String(snapshot.llm.lastError), /overloaded/);
  assert.ok(snapshot.llm.plans.w === null, "no plan is claimed when none was produced");
  const move = snapshot.history.find((entry) => entry.color === "w" && entry.jev);
  assert.ok(move.jev.notes.some((note) => /No plan|overloaded|Strategist/.test(note)), `expected an explanation: ${move.jev.notes.join(" | ")}`);
  assert.equal(game.lastError, null, "a strategist failure is not a game error");
  game.dispose();
});

await test("a nonsense plan is refused and the preset decides", async () => {
  const nonsense = {
    mock: false,
    provider: "gemini",
    model: "gemini-3.8-flash",
    async generateJson() {
      return {
        ok: true,
        json: { plan: "sacrifice_all_pieces", risk: "yolo", review_after_plies: 900, commentary: "trust me" },
        text: "{}",
        usage: { inputTokens: 100, outputTokens: 10, thoughtTokens: 0 },
        costUsd: 0.0001,
        attempts: 1,
        elapsedMs: 5,
        notes: [],
      };
    },
  };
  const game = makeGame({ players: { w: SEAT("strategist"), b: SEAT("balanced") }, llmClient: nonsense });
  const plies = await playPlies(game, 4);
  assert.ok(plies >= 4, "an unusable plan must not stop play");
  const snapshot = game.snapshot();
  assert.equal(snapshot.llm.plans.w, null, "the unusable plan must not be adopted");
  assert.match(String(snapshot.llm.lastError), /unusable/);
  const move = snapshot.history.find((entry) => entry.color === "w" && entry.jev);
  assert.ok(move.jev.llm === null || move.jev.llm.plan === null, "no plan is recorded as in force");
  game.dispose();
});

await test("the plan survives into a clocked game and costs are accumulated", async () => {
  const llm = new MockLlmClient();
  const game = makeGame({
    players: { w: SEAT("strategist"), b: SEAT("strategist") },
    llmClient: llm,
    timeControl: { initialMs: 120_000, incrementMs: 0 },
  });
  const plies = await playPlies(game, 8);
  const snapshot = game.snapshot();
  assert.ok(plies >= 6);
  assert.ok(snapshot.clocks.w < 120_000, "the clock ran");
  assert.ok(typeof snapshot.llm.tokens === "number" && snapshot.llm.tokens >= 0);
  assert.ok(snapshot.llm.plans.w || snapshot.llm.plans.b, "at least one seat has a plan in force");
  game.dispose();
});

// ===========================================================================

await Promise.all(pending);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.error.message}`);
  process.exitCode = 1;
}
