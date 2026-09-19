/**
 * Strategy-layer tests, run with: node tests/pipelines.test.mjs
 *
 * Jev is mocked here on purpose. These tests are about the plumbing around the model:
 * legal moves only, contract-shaped records, sane fallbacks when Jev is unavailable or
 * answers something impossible, the veto loop, and the composite arithmetic. Whether
 * Jev's chess judgement is *good* is a separate question — that is what
 * tools/experiment.mjs measures against the real API.
 */

import assert from "node:assert/strict";
import { Chess } from "../src/engine/chess.js";
import { selectMove } from "../src/jev/pipelines.js";
import { resolveStrategy, strategiesPayload, DEFAULT_STRATEGY_ID } from "../src/strategies.js";
import { buildJevState, buildAuditState, boardText, describeMove } from "../src/jev/state.js";
import {
  readChoiceAnswer,
  readNoulAnswer,
  readScoreAnswer,
  clamp01,
  DIMENSIONS,
} from "../src/jev/questions.js";
import { combine, searchUnit } from "../src/jev/pipelines.js";
import { analyzeRoot } from "../src/engine/search.js";
import { Game } from "../src/game.js";

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];
/** Promises from async tests, awaited before the summary is printed. */
const pending = [];

function report(name, error) {
  failures.push({ name, error });
  console.log(`  FAIL  ${name}\n        ${error.message.split("\n").join("\n        ")}`);
}

/** Sync or async; async bodies are collected and awaited at the end of the file. */
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pending.push(
        result.then(
          () => {
            passed += 1;
          },
          (error) => report(name, error),
        ),
      );
    } else {
      passed += 1;
    }
  } catch (error) {
    report(name, error);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    report(name, error);
  }
}

// ---------------------------------------------------------------------------
// a controllable stand-in for Jev
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {(ctx:object)=>number} [opts.score]  0..1 for a Score question
 * @param {(keys:string[], ctx:object)=>string} [opts.choice]  key to nominate
 * @param {(ctx:object)=>number} [opts.noul]   0..1 for a Noul question
 * @param {boolean} [opts.fail]                make every request throw
 * @param {boolean} [opts.dumb]                answer nothing useful at all
 * @param {(ctx:object)=>void} [opts.onCall]
 */
function makeJev(opts = {}) {
  const { score = () => 0.5, choice = (keys) => keys[0], noul = () => 0, fail = false, dumb = false, onCall } = opts;
  const client = {
    mock: true,
    model: "mock-jev",
    stats: { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 },
    calls: [],
    async systemOne({ state, questions = {} }) {
      client.stats.requests += 1;
      client.calls.push({ state, questions });
      if (fail) throw new Error("mock Jev is down");
      const call = client.calls.length;
      if (onCall) onCall({ state, questions, call });
      const answers = {};
      if (dumb) return { model: "mock-jev", answers, usage: { input_tokens: 1, output_tokens: 0 }, attempts: 1, elapsedMs: 1, mock: true };
      for (const [id, question] of Object.entries(questions)) {
        const ctx = { id, question, questions, state, call, client };
        if (question.type === "choice") {
          const keys = Object.keys(question.criteria ?? {});
          const chosen = choice(keys, ctx);
          const probabilities = {};
          for (const key of keys) probabilities[key] = key === chosen ? 0.7 : 0.3 / Math.max(1, keys.length - 1);
          answers[id] = { type: "choice", choice: chosen, probabilities, confidence: 0.7 };
        } else if (question.type === "score") {
          const levels = (question.criteria ?? []).length;
          const unit = Math.min(1, Math.max(0, score(ctx)));
          answers[id] = {
            type: "score",
            score: unit * (levels - 1),
            probabilities: {},
            confidence: 0.8,
            legend: {},
          };
        } else {
          answers[id] = { type: "noul", noul: Math.min(1, Math.max(0, noul(ctx))) };
        }
      }
      return { model: "mock-jev", answers, usage: { input_tokens: 120, output_tokens: 12 }, attempts: 1, elapsedMs: 3, mock: true };
    },
  };
  return client;
}

const STRATEGY = (id, weights) => resolveStrategy({ strategyId: id, weights });

function playablePosition() {
  return new Chess("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3");
}

// ===========================================================================
// 1. answer reading
// ===========================================================================

console.log("\n== answer reading ==");

test("readScoreAnswer normalizes against the level count", () => {
  assert.equal(readScoreAnswer({ score: 3 }, 4), 1);
  assert.equal(readScoreAnswer({ score: 1.5 }, 4), 0.5);
  assert.equal(readScoreAnswer({ score: 0 }, 4), 0);
  assert.equal(readScoreAnswer({ score: 9 }, 4), 1, "clamped");
  assert.equal(readScoreAnswer({ score: -2 }, 4), 0, "clamped");
});

test("readScoreAnswer rejects junk instead of inventing a number", () => {
  assert.equal(readScoreAnswer(null, 4), null);
  assert.equal(readScoreAnswer({}, 4), null);
  assert.equal(readScoreAnswer({ score: "abc" }, 4), null);
  assert.equal(readScoreAnswer({ score: Number.NaN }, 4), null);
});

test("readNoulAnswer passes a probability through and clamps", () => {
  assert.equal(readNoulAnswer({ noul: 0.72 }), 0.72);
  assert.equal(readNoulAnswer({ noul: "0.4" }), 0.4);
  assert.equal(readNoulAnswer({ noul: 1.4 }), 1);
  assert.equal(readNoulAnswer({}), null);
});

test("readChoiceAnswer keeps only real options and renormalizes", () => {
  const parsed = readChoiceAnswer(
    { choice: "c2 Nf3", probabilities: { "c1 e4": 0.3, "c2 Nf3": 0.5, "c9 Bb5": 0.2 } },
    ["c1 e4", "c2 Nf3"],
  );
  assert.equal(parsed.choice, "c2 Nf3");
  assert.equal(parsed.invalid, null);
  assert.deepEqual(Object.keys(parsed.probabilities).sort(), ["c1 e4", "c2 Nf3"]);
  assert.equal(Math.round((parsed.probabilities["c1 e4"] + parsed.probabilities["c2 Nf3"]) * 1000) / 1000, 1);
});

test("readChoiceAnswer survives an invented move name", () => {
  const parsed = readChoiceAnswer(
    { choice: "Nf7", probabilities: { "c1 e4": 0.2, "c2 Nf3": 0.8 } },
    ["c1 e4", "c2 Nf3"],
  );
  assert.equal(parsed.invalid, "Nf7", "the invented name is reported");
  assert.equal(parsed.choice, "c2 Nf3", "the best real option is used instead");
});

test("readChoiceAnswer with nothing usable reports no choice", () => {
  const parsed = readChoiceAnswer({ choice: "Nf7", probabilities: { Nf7: 1 } }, ["c1 e4"]);
  assert.equal(parsed.choice, null);
  assert.equal(parsed.invalid, "Nf7");
});

test("clamp01 is total", () => {
  assert.equal(clamp01(undefined), 0);
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01("x"), 0);
});

// ===========================================================================
// 2. composite arithmetic
// ===========================================================================

console.log("\n== composite arithmetic ==");

test("combine is a weighted average that ignores missing signals", () => {
  assert.equal(combine({ a: 0, b: 1 }, { a: 1, b: 1 }), 0.5);
  assert.equal(combine({ a: 1, b: 0 }, { a: 0.75, b: 0.25 }), 0.75);
  assert.equal(combine({ a: 1, b: 0.5 }, { a: 1 }), 1, "b is not weighted, so it is ignored");
  assert.equal(combine({ a: 0.4 }, {}), 0.4, "no weights at all falls back to the signal");
});

test("combine with all-zero weights still returns something finite", () => {
  const value = combine({ search: 0.42 }, { search: 0 });
  assert.ok(Number.isFinite(value));
});

test("searchUnit gives the best move 0.5 and punishes a large drop", () => {
  assert.equal(searchUnit(30, 30, null), 0.5);
  assert.ok(searchUnit(30 - 200, 30, null) < 0.2, "200cp down must score low");
  assert.ok(searchUnit(30 - 20, 30, null) > 0.4, "20cp down must stay close");
  assert.equal(searchUnit(99_999, 30, 2), 1, "mate for us tops out");
  assert.equal(searchUnit(-99_999, 30, null), 0, "a hopeless score bottoms out");
  assert.equal(searchUnit(-99_999, 30, -2), 0, "getting mated bottoms out");
});

// ===========================================================================
// 3. the state Jev sees
// ===========================================================================

console.log("\n== state building ==");

test("boardText is a labelled 8x8 diagram, rank 8 first", () => {
  const text = boardText(new Chess().board().flat());
  const lines = text.split("\n");
  assert.equal(lines.length, 9);
  assert.equal(lines[0], "8  r n b q k b n r");
  assert.equal(lines[7], "1  R N B Q K B N R");
  assert.equal(lines[8].trim(), "a b c d e f g h");
});

test("buildJevState describes every candidate with facts, not opinions", () => {
  const chess = new Chess();
  const moves = chess.moves().filter((move) => ["e4", "Nf3", "a3"].includes(move.san));
  const state = buildJevState({
    chess,
    candidates: moves.map((move, index) => ({ id: `c${index + 1}`, move })),
    lastMovesSan: [],
  });

  assert.equal(state.position.side_to_move, "White");
  assert.match(state.position.board_8_to_1, /8 {2}r n b q k b n r/);
  assert.equal(state.candidates.length, 3);
  const e4 = state.candidates.find((candidate) => candidate.move_san === "e4");
  assert.equal(e4.captures, "nothing");
  assert.equal(e4.gives_check, false);
  assert.match(e4.how_the_move_reads, /pawn on e2 moves to e4/);
  assert.equal(e4.opponent_legal_replies, 20);
  assert.match(e4.board_after_8_to_1, /4  \. \. \. \. P \. \. \./, "the pawn is on e4 in the diagram after the move");
  assert.ok(!("code_search_hint_centipawns" in e4), "the search's opinion must not leak into the state by default");
  assert.ok(!("opponent_captures_available" in e4), "capture evidence is off by default");
});

test("buildJevState can include the search hint only when asked", () => {
  const chess = new Chess();
  const move = chess.moves().find((entry) => entry.san === "e4");
  const state = buildJevState({
    chess,
    candidates: [{ id: "c1", move }],
    includeSearchHints: true,
    searchCpBySan: { e4: 42 },
    exposeCaptureEvidence: true,
  });
  assert.equal(state.candidates[0].code_search_hint_centipawns, 42);
  assert.ok(Array.isArray(state.candidates[0].opponent_captures_available));
});

test("describeMove explains captures, castles and promotions", () => {
  const capture = new Chess("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
  const exd5 = capture.moves().find((move) => move.san === "exd5");
  assert.match(describeMove(capture, exd5), /pawn on e4 captures the pawn on d5/);

  const castle = new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  const short = castle.moves().find((move) => move.san === "O-O");
  assert.match(describeMove(castle, short), /castles kingside/);

  const promotion = new Chess("8/P7/8/8/8/8/8/K6k w - - 0 1");
  const promote = promotion.moves().find((move) => move.san.startsWith("a8=Q"));
  assert.match(describeMove(promotion, promote), /promotes to a queen/);
});

test("buildAuditState shows the nomination and the opponent's replies", () => {
  const chess = new Chess("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
  const move = chess.moves().find((entry) => entry.san === "exd5");
  const state = buildAuditState({ chess, move });
  assert.equal(state.nomination.move_san, "exd5");
  assert.match(state.nomination.board_after_8_to_1, /5  \. \. \. P \. \. \./, "the pawn now stands on d5");
  assert.ok(state.nomination.opponent_legal_replies > 0);
});

test("every dimension produces distinct, concrete levels", () => {
  const ctx = { side: { name: "White" }, opponent: { name: "Black" }, candidate: { id: "c1", san: "Nf3" } };
  for (const [key, dimension] of Object.entries(DIMENSIONS)) {
    const levels = dimension.levels(ctx);
    assert.equal(levels.length, 4, `${key} should have four levels`);
    assert.equal(new Set(levels).size, 4, `${key} levels must not repeat`);
    for (const level of levels) {
      assert.ok(typeof level === "string" && level.length > 30, `${key} level is too thin to judge against`);
      assert.ok(!/\b(moderately|somewhat|very|extremely)\b/i.test(level), `${key} uses a degree word instead of a situation: ${level}`);
    }
    assert.ok(dimension.instructions(ctx).includes("c1"), `${key} instructions must name the candidate`);
  }
});

// ===========================================================================
// 4. shortlist-composite
// ===========================================================================

console.log("\n== shortlist-composite ==");

test("only legal moves are ever chosen", async () => {
  const chess = playablePosition();
  const legal = new Set(chess.moves().map((move) => move.san));
  const jev = makeJev({});
  const { move, record } = await selectMove({
    chess,
    strategy: STRATEGY("balanced"),
    jevClient: jev,
    lastMovesSan: [],
  });
  assert.ok(legal.has(move.san), `${move.san} should be legal`);
  assert.equal(record.chosenSan, move.san);
});

test("a candidate Jev loves wins even when the search ranks it lower", async () => {
  const chess = playablePosition();
  const jev = makeJev({
    score: ({ id }) => (id.startsWith("cand_c2_") ? 1 : 0),
    choice: (keys) => keys[1],
  });
  const { record } = await selectMove({ chess, strategy: STRATEGY("balanced"), jevClient: jev, lastMovesSan: [] });

  // Candidate c2 is the search's second choice by construction. Expectations are read
  // from the record itself rather than from a second, differently-tuned search run.
  const secondBySearch = record.candidates.find((candidate) => candidate.searchRank === 2);
  assert.ok(secondBySearch, "the record keeps every candidate's search rank");
  assert.equal(record.chosenSan, secondBySearch.san, "Jev's judgement moved the choice off the search's top move");
  assert.equal(record.searchRankOfChosen, 2, "the record keeps the search's own ranking for comparison");
  assert.ok(record.notes.some((note) => /search preferred/.test(note)), "the panel is told the search disagreed");
  assert.ok(record.usage.input_tokens > 0);
  assert.equal(record.requests, 1);
});

test("the search still wins when Jev has nothing to say about it", async () => {
  const chess = playablePosition();
  const analysis = analyzeRoot(chess, { depth: 2, quiescence: 1, timeBudgetMs: 400 });
  const jev = makeJev({ dumb: true });
  const { move, record } = await selectMove({ chess, strategy: STRATEGY("balanced"), jevClient: jev, lastMovesSan: [] });
  assert.equal(move.san, analysis.moves[0].san);
  assert.ok(record.notes.some((note) => /no usable|search score decided/.test(note)));
});

test("an unreachable Jev degrades to the search instead of failing the game", async () => {
  const chess = playablePosition();
  const analysis = analyzeRoot(chess, { depth: 2, quiescence: 1, timeBudgetMs: 400 });
  const jev = makeJev({ fail: true });
  const { move, record } = await selectMove({ chess, strategy: STRATEGY("balanced"), jevClient: jev, lastMovesSan: [] });
  assert.equal(move.san, analysis.moves[0].san);
  assert.ok(record.errors.length > 0, "the failure is recorded");
  assert.ok(record.notes.some((note) => /unavailable/.test(note)));
  assert.equal(record.requests, 0);
});

test("with one dimension the composite uses the search and that dimension only", async () => {
  const chess = playablePosition();
  const jev = makeJev({ score: ({ id }) => (id.includes("_safety") ? 1 : 0), choice: (keys) => keys[0] });
  const { record } = await selectMove({ chess, strategy: STRATEGY("tactical"), jevClient: jev, lastMovesSan: [] });
  const used = Object.keys(record.weights);
  assert.ok(used.includes("search") && used.includes("safety"));
  assert.ok(!used.includes("kingPressure"), "tactical does not ask about king pressure");
  const missingPressure = record.candidates.every((candidate) => !("kingPressure" in candidate.dims));
  assert.ok(missingPressure);
});

test("the record matches the contract the UI renders", async () => {
  const chess = playablePosition();
  const jev = makeJev({});
  const { record } = await selectMove({ chess, strategy: STRATEGY("balanced"), jevClient: jev, lastMovesSan: [] });

  for (const key of [
    "mock",
    "model",
    "pipeline",
    "strategyId",
    "strategyName",
    "chosenSan",
    "chosenFrom",
    "chosenTo",
    "chosenRank",
    "searchRankOfChosen",
    "candidates",
    "weights",
    "notes",
    "usage",
    "requests",
    "elapsedMs",
    "errors",
  ]) {
    assert.ok(key in record, `JevMove.${key} is missing`);
  }
  assert.ok(record.candidates.length >= 3 && record.candidates.length <= 12);
  for (const candidate of record.candidates) {
    for (const key of ["san", "from", "to", "chosen", "searchCp", "searchRank", "searchScore", "dims", "composite", "tags"]) {
      assert.ok(key in candidate, `candidate.${key} is missing`);
    }
    assert.ok(candidate.composite >= 0 && candidate.composite <= 1, "composite stays in 0..1");
    assert.ok(Array.isArray(candidate.tags));
  }
  assert.equal(record.candidates.filter((candidate) => candidate.chosen).length, 1, "exactly one candidate is marked chosen");
  assert.equal(record.candidates[0].composite >= record.candidates[record.candidates.length - 1].composite, true);
});

test("candidate limit is respected and the shortlist is the search's best", async () => {
  const chess = playablePosition();
  const jev = makeJev({});
  const strategy = resolveStrategy({ strategyId: "balanced" });
  strategy.candidateLimit = 4;
  const { record } = await selectMove({ chess, strategy, jevClient: jev, lastMovesSan: [] });
  assert.equal(record.candidates.length, 4);
  const ranks = record.candidates.map((candidate) => candidate.searchRank).sort((a, b) => a - b);
  assert.deepEqual(ranks, [1, 2, 3, 4], "the shortlist is exactly the search's top N");
});

test("the request is one call carrying every question", async () => {
  const chess = playablePosition();
  const jev = makeJev({});
  await selectMove({ chess, strategy: STRATEGY("balanced"), jevClient: jev, lastMovesSan: [] });
  assert.equal(jev.calls.length, 1, "one request per move");
  const questions = jev.calls[0].questions;
  assert.ok(questions.best_move, "there is a choice question");
  assert.ok(questions.standing && questions.phase && questions.plan, "the assessment questions ride along");
  const dims = STRATEGY("balanced").dims;
  for (const id of Object.keys(questions).filter((key) => key.startsWith("cand_"))) {
    const dim = id.split("_").pop();
    assert.ok(dims.includes(dim), `${id} should be one of the strategy's dimensions`);
  }
  assert.ok(Object.keys(questions).length > 10);
});

// ===========================================================================
// 5. pure-choice
// ===========================================================================

console.log("\n== pure-choice ==");

test("Jev's nominated move plays, with no search filter", async () => {
  const chess = playablePosition();
  const legal = chess.moves();
  const target = legal[4];
  const jev = makeJev({
    choice: (keys) => {
      const match = keys.find((key) => key.endsWith(` ${target.san}`));
      return match ?? keys[0];
    },
  });
  const { move, record } = await selectMove({ chess, strategy: STRATEGY("pure-jev"), jevClient: jev, lastMovesSan: [] });
  assert.equal(move.san, target.san);
  assert.equal(record.pipeline, "pure-choice");
  assert.equal(record.requests, 1);
  assert.ok(record.notes.some((note) => /No search filtering/.test(note)));
  assert.ok(record.search.forDisplayOnly, "the search is only for the bar in this pipeline");
});

test("an invented move falls back to Jev's next-best legal option", async () => {
  const chess = playablePosition();
  let optionKeys = [];
  const jev = makeJev({});
  // The mock turns any returned key into a real option, so replace the response with
  // one that names a move which is not among the options at all.
  jev.systemOne = async ({ questions }) => {
    optionKeys = Object.keys(questions.best_move.criteria);
    const probabilities = {};
    for (const key of optionKeys) probabilities[key] = 0.05;
    probabilities[optionKeys[3]] = 0.8;
    return {
      model: "mock-jev",
      answers: { best_move: { type: "choice", choice: "Qxh8", probabilities, confidence: 0.8 } },
      usage: { input_tokens: 10, output_tokens: 1 },
      attempts: 1,
      elapsedMs: 1,
      mock: true,
    };
  };
  const { move, record } = await selectMove({ chess, strategy: STRATEGY("pure-jev"), jevClient: jev, lastMovesSan: [] });
  const expectedSan = optionKeys[3].split(" ").slice(1).join(" ");
  assert.equal(move.san, expectedSan, "the highest-probability real option played");
  assert.ok(record.notes.some((note) => /not a legal move/.test(note)));
  assert.equal(record.errors.length, 0, "an invented name is a note, not an error: the game recovered");
});

test("no usable answer at all defers to the search and says so", async () => {
  const chess = playablePosition();
  const analysis = analyzeRoot(chess, { depth: 2, quiescence: 1, timeBudgetMs: 400 });
  const jev = makeJev({ dumb: true });
  const { move, record } = await selectMove({ chess, strategy: STRATEGY("pure-jev"), jevClient: jev, lastMovesSan: [] });
  assert.equal(move.san, analysis.moves[0].san);
  assert.ok(record.notes.some((note) => /no usable answer/.test(note)));
});

// ===========================================================================
// 6. nominate-verify
// ===========================================================================

console.log("\n== nominate-verify ==");

test("a vetoed nomination is excluded and Jev is asked again", async () => {
  const chess = playablePosition();
  const strategy = STRATEGY("jev-verify");
  let firstNominationSan = null;
  const jev = makeJev({
    choice: (keys, ctx) => {
      if (ctx.id !== "best_move") return keys[0]; // standing/phase/plan ride along in the same call
      if (ctx.call === 1) {
        firstNominationSan = keys[2].split(" ").slice(1).join(" ");
        return keys[2];
      }
      return keys[0];
    },
    noul: ({ id, call }) => {
      if (id !== "audit_hangs_material") return 0.01;
      return call === 2 ? 0.9 : 0.01; // veto on the first nomination, approve the second
    },
  });

  const { move, record } = await selectMove({ chess, strategy, jevClient: jev, lastMovesSan: [] });
  assert.equal(record.pipeline, "nominate-verify");
  assert.equal(record.vetoed.length, 1);
  assert.equal(record.vetoed[0], firstNominationSan);
  assert.notEqual(move.san, firstNominationSan, "the vetoed move must not play");
  assert.equal(record.requests, 4, "two nominations, each audited");
  assert.ok(record.audit.length >= 8, "every audit question is recorded");
  assert.ok(
    record.audit.some((entry) => entry.veto),
    "the veto is visible in the panel",
  );
  assert.ok(record.notes.some((note) => /vetoed its own nomination/.test(note)));
  assert.ok(record.notes.some((note) => /survived its own audit/.test(note)));
});

test("the second nomination's option list really excludes the vetoed move", async () => {
  const chess = playablePosition();
  const strategy = STRATEGY("jev-verify");
  const seen = [];
  const jev = makeJev({
    choice: (keys, ctx) => {
      if (ctx.id !== "best_move") return keys[0];
      seen.push(keys);
      return ctx.call === 1 ? keys[1] : keys[0];
    },
    noul: ({ id, call }) => (id === "audit_hangs_material" && call === 2 ? 0.95 : 0),
  });
  await selectMove({ chess, strategy, jevClient: jev, lastMovesSan: [] });
  assert.equal(seen.length, 2);
  const vetoedKey = seen[0][1];
  assert.ok(!seen[1].includes(vetoedKey), "the vetoed move is gone from the second request");
  assert.equal(seen[1].length, seen[0].length - 1);
});

test("endless vetoes stop at the limit and defer to the search", async () => {
  const chess = playablePosition();
  const analysis = analyzeRoot(chess, { depth: 2, quiescence: 1, timeBudgetMs: 400 });
  const jev = makeJev({
    choice: (keys) => keys[0],
    noul: ({ id }) => (id === "audit_regret" ? 0.99 : 0),
  });
  const { move, record } = await selectMove({ chess, strategy: STRATEGY("jev-verify"), jevClient: jev, lastMovesSan: [] });
  assert.equal(record.vetoed.length, 4, "maxVetoes + 1 nominations were rejected");
  assert.equal(record.requests, 8);
  assert.ok(record.searchRankOfChosen >= 1);
  assert.ok(analysis.moves.some((entry) => entry.san === move.san), "a legal move still played");
  assert.ok(record.notes.some((note) => /Veto limit reached|search's top move/.test(note)));
});

test("an audit that never answers approves the nomination", async () => {
  const chess = playablePosition();
  const jev = makeJev({
    choice: (keys) => keys[0],
    noul: () => 0.0,
  });
  const { record } = await selectMove({ chess, strategy: STRATEGY("jev-verify"), jevClient: jev, lastMovesSan: [] });
  assert.equal(record.vetoed.length, 0);
  assert.equal(record.requests, 2);
});

// ===========================================================================
// 7. search-only baseline
// ===========================================================================

console.log("\n== search-only baseline ==");

test("the baseline never asks Jev and still returns a full record", async () => {
  const chess = playablePosition();
  const jev = makeJev({ fail: true });
  const { move, record } = await selectMove({ chess, strategy: STRATEGY("code-only"), jevClient: jev, lastMovesSan: [] });
  assert.equal(jev.calls.length, 0, "no request must be made");
  assert.equal(record.requests, 0);
  assert.equal(record.chosenRank, 1);
  assert.ok(move.san);
  assert.equal(record.model, null);
});

test("with searchDepth 0 the baseline still works (static, one ply)", async () => {
  const chess = playablePosition();
  const strategy = STRATEGY("code-only");
  strategy.searchDepth = 0;
  const { move, record } = await selectMove({ chess, strategy, jevClient: makeJev({}), lastMovesSan: [] });
  assert.ok(move.san);
  assert.ok(record.candidates.length > 0);
});

// ===========================================================================
// 8. strategies
// ===========================================================================

console.log("\n== strategies ==");

test("every preset resolves and its active weights are the ones it can use", () => {
  const payload = strategiesPayload();
  assert.ok(payload.presets.length >= 6);
  assert.equal(payload.defaultStrategyId, DEFAULT_STRATEGY_ID);
  assert.ok(payload.presets.some((preset) => preset.best), "one preset is marked best");
  const best = payload.presets.find((preset) => preset.best);
  assert.equal(best.id, "balanced");
  assert.equal(best.pipeline, "shortlist-composite");

  for (const preset of payload.presets) {
    const resolved = resolveStrategy({ strategyId: preset.id });
    assert.equal(resolved.id, preset.id);
    assert.ok(Object.keys(resolved.weights).length > 0, `${preset.id} has no active weights`);
    for (const key of Object.keys(resolved.weights)) {
      const allowed =
        key === "search"
          ? ["shortlist-composite", "search-only"].includes(resolved.pipeline)
          : key === "choice"
            ? resolved.pipeline !== "search-only"
            : resolved.dims.includes(key);
      assert.ok(allowed, `${preset.id} carries an unusable weight: ${key}`);
    }
    assert.ok(Number.isFinite(resolved.timeBudgetMs) && resolved.timeBudgetMs > 0);
  }
});

test("weight overrides are clamped, and unknown keys are dropped", () => {
  const resolved = resolveStrategy({ strategyId: "balanced", weights: { search: 5, safety: -3, nonsense: 1, quality: "0.4" } });
  assert.equal(resolved.weights.search, 1);
  assert.equal(resolved.weights.safety, 0);
  assert.equal(resolved.weights.quality, 0.4);
  assert.ok(!("nonsense" in resolved.weights));
  assert.deepEqual(resolved.overrides, { search: 1, safety: 0, quality: 0.4 });
});

test("an unknown preset falls back to the default rather than throwing", () => {
  const resolved = resolveStrategy({ strategyId: "does-not-exist" });
  assert.equal(resolved.id, DEFAULT_STRATEGY_ID);
});

test("weightsNormalized sums to 1", () => {
  const resolved = resolveStrategy({ strategyId: "positional" });
  const total = Object.values(resolved.weightsNormalized).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

// ===========================================================================
// 9. the game object
// ===========================================================================

console.log("\n== game ==");

function makeGame(overrides = {}) {
  return new Game({
    id: "g_test",
    mode: "human-vs-jev",
    humanColor: "w",
    playerConfigs: { b: { strategyId: "code-only" }, ...overrides },
    jevClient: makeJev({}),
    modelName: "jev-latest",
    hasApiKey: true,
  });
}

await testAsync("a human move is applied and answered by the AI seat", async () => {
  const game = makeGame();
  const result = game.submitHumanMove("e4");
  assert.equal(result.ok, true);
  assert.equal(game.history.length, 1);
  assert.equal(game.history[0].by, "human");
  assert.equal(game.snapshot().turn, "b");

  const deadline = Date.now() + 5000;
  while (game.history.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(game.history.length, 2, "the AI replied");
  assert.equal(game.history[1].by, "jev");
  assert.ok(game.history[1].jev, "the AI move carries its record");
  game.dispose();
});

await testAsync("an illegal human move changes nothing and explains itself", async () => {
  const game = makeGame();
  const before = game.snapshot().fen;
  const result = game.submitHumanMove({ from: "e2", to: "e5" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "illegal-move");
  assert.match(result.message, /not a legal move/);
  assert.equal(game.snapshot().fen, before);
  game.dispose();
});

await testAsync("the human cannot move for the AI seat", async () => {
  const game = makeGame();
  game.submitHumanMove("e4");
  const result = game.submitHumanMove("e5");
  assert.equal(result.ok, false);
  assert.equal(result.code, "not-your-turn");
  game.dispose();
});

await testAsync("undo takes back a full move pair and returns the turn to the human", async () => {
  const game = makeGame();
  game.submitHumanMove("e4");
  const deadline = Date.now() + 5000;
  while (game.history.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const result = game.undo();
  assert.equal(result.ok, true);
  assert.equal(game.history.length, 0, "both plies are gone");
  assert.equal(game.snapshot().turn, "w");
  assert.equal(game.snapshot().fen, game.startFen);
  game.dispose();
});

await testAsync("resignation ends the game with a reason", async () => {
  const game = makeGame();
  const result = game.resign("w");
  assert.equal(result.ok, true);
  const status = game.snapshot().status;
  assert.equal(status.over, true);
  assert.equal(status.result, "0-1");
  assert.equal(status.reason, "resignation");
  assert.equal(game.snapshot().legalMoves.length, 0, "no moves are offered once the game is over");
  const again = game.submitHumanMove("e4");
  assert.equal(again.code, "game-over");
  game.dispose();
});

await testAsync("a draw offer to a Jev opponent is answered by Jev", async () => {
  const game = makeGame();
  const result = await game.offerDraw("w");
  assert.equal(result.ok, true);
  assert.equal(result.pending, undefined, "a Jev seat decides immediately");
  assert.ok(typeof result.accepted === "boolean");
  game.dispose();
});

await testAsync("clocks count down and a flag ends the game", async () => {
  const game = new Game({
    id: "g_clock",
    mode: "human-vs-jev",
    humanColor: "w",
    timeControl: { initialMs: 10_000, incrementMs: 0 },
    playerConfigs: { b: { strategyId: "code-only" } },
    jevClient: makeJev({}),
    modelName: "jev-latest",
    hasApiKey: true,
  });
  game.clocks.w = 5;
  game.clocks.updatedAt = Date.now() - 50;
  const deadline = Date.now() + 3000;
  while (!game.snapshot().status.over && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  const status = game.snapshot().status;
  assert.equal(status.over, true, "the clock ran out");
  assert.equal(status.reason, "timeout");
  assert.equal(status.result, "0-1", "White flagged, so Black wins");
  game.dispose();
});

await testAsync("changing a Jev seat's strategy mid-game works and is announced", async () => {
  const game = makeGame();
  const result = game.setPlayer("b", { strategyId: "attacking", weights: { kingPressure: 0.9 } });
  assert.equal(result.ok, true);
  const black = game.snapshot().players.b;
  assert.equal(black.strategyId, "attacking");
  assert.equal(black.weights.kingPressure, 0.9);
  const humanSeat = game.setPlayer("w", { strategyId: "balanced" });
  assert.equal(humanSeat.ok, false, "a human seat cannot be replaced by a strategy");
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
