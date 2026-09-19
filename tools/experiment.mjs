/**
 * Does Jev actually understand chess positions?
 *
 * This is the measurement the whole design rests on. The app assumes a System One model
 * can look at a board diagram, compare a handful of candidate resulting positions, and
 * make a sound judgement. That assumption is testable, and this file tests it against
 * labels the rules engine can prove, so the numbers do not depend on our opinion.
 *
 * Run with a real key:   node tools/experiment.mjs
 * Run the mechanics only: node tools/experiment.mjs --mock      (numbers are meaningless)
 *
 * Each experiment asks the same kind of question the game asks, then checks the answer
 * against a fact the engine computed first:
 *
 *   1. Mate in one     — positions where a mate in 1 exists. Does Jev's choice find it?
 *   2. Win material    — positions where one move wins material by force. Does Jev see it?
 *   3. Spot the blunder— one candidate hangs a piece. Does Jev score its safety low?
 *   4. Rank agreement  — how often Jev's top choice matches a 3-ply search, and how well
 *                        its quality scores correlate with the search scores.
 *   5. Prompt shape    — the same positions with and without board diagrams per candidate,
 *                        and with and without the list of captures the opponent has.
 *
 * Output: a readable report, plus experiments/results-<timestamp>.json.
 *
 * Note on cost: every position is one request. The default suite is about 40 requests of
 * ~2-4k input tokens each — a fraction of a cent at Jev's $0.042/Mtok input price.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Chess } from "../src/engine/chess.js";
import { analyzeRoot } from "../src/engine/search.js";
import { loadDotEnv } from "../src/env.js";
import { createJevClient } from "../src/jev/client.js";
import { resolveApiKey } from "../src/win-key.js";
import { buildJevState } from "../src/jev/state.js";
import { buildCandidateQuestions, readChoiceAnswer, readScoreAnswer, DIMENSIONS } from "../src/jev/questions.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
loadDotEnv(join(ROOT, ".env"));

// Same key resolution as the server: environment/.env first, then Windows secure storage,
// so `npm run key:set` alone is enough to make this work.
const { key: API_KEY, source: KEY_SOURCE } = await resolveApiKey();

const FORCE_MOCK = process.argv.includes("--mock") || !API_KEY;
const ONLY = argValue("--only"); // e.g. --only prompt-shape
const MODEL = process.env.TYPESAFE_MODEL ?? "jev-latest";

const client = createJevClient({
  apiKey: API_KEY,
  forceMock: FORCE_MOCK,
  model: MODEL,
  maxAttempts: 3,
});

/**
 * Seed positions. Chosen to span tactics, quiet middlegames, endgames and an opening,
 * so the suite is not all one kind of position. Labels come from the engine, never from
 * this list — see `labelMate` and `labelMaterial`.
 */
const SEEDS = [
  "r5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1", // Black to move and mate in one (Ra1#)
  "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1",
  "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 6",
  "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
  "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
  "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
  "2rq1rk1/pb1nbppp/1p2pn2/8/2BP4/2N1PN2/PP2QPPP/2R2RK1 w - - 0 14",
  "8/8/8/4k3/8/8/4K3/6Q1 w - - 0 1",
  "6k1/5p1p/6p1/8/8/6P1/5P1P/3Q2K1 w - - 0 1",
  "r2q1rk1/pp1bbppp/2n1pn2/2pp4/2PP4/2N1PN2/PP2BPPP/R1BQ1RK1 w - - 0 10",
  "1k6/1P6/8/8/8/8/8/K7 w - - 0 1",
  "rnbqkbnr/ppp2ppp/8/3pp3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 4",
  "8/8/8/8/8/5k2/6q1/7K w - - 0 1",
  "3r2k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1",
  // Simple positions where one move plainly wins material, so experiment 2 always has
  // labels to work with. Every one is verified by the engine before Jev sees it.
  "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1",
  "3qk3/8/8/8/8/8/8/3RK3 w - - 0 1",
  "8/8/8/3q4/8/8/8/3RK2k w - - 0 1",
  "4k3/8/8/8/8/8/4b3/4K3 w - - 0 1",
  "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2",
];

const results = { startedAt: new Date().toISOString(), model: MODEL, mock: FORCE_MOCK, experiments: {} };

console.log(`JevChess — is Jev any good at chess?`);
console.log(`model: ${MODEL}   (key from: ${KEY_SOURCE})`);
console.log(`${FORCE_MOCK ? "[MOCK: the numbers below are meaningless, they only prove the harness runs]\n" : ""}`);

// ---------------------------------------------------------------------------
// labelling: the engine decides the right answer before Jev is asked
// ---------------------------------------------------------------------------

/** Positions with a forced mate in one, labelled with the mating move. */
function labelMate() {
  const labelled = [];
  for (const fen of SEEDS) {
    let chess;
    try {
      chess = new Chess(fen);
    } catch {
      continue;
    }
    const analysis = analyzeRoot(chess, { depth: 2, quiescence: 1, timeBudgetMs: 600 });
    const best = analysis.moves[0];
    if (!best || best.mateIn !== 1) continue;
    const mates = analysis.moves.filter((move) => move.mateIn === 1);
    labelled.push({ fen, mates: mates.map((move) => move.san), bestSan: best.san, legal: analysis.moves.length });
  }
  return labelled;
}

/** Positions where the best move wins at least 200cp more than the runner-up. */
function labelMaterial() {
  const labelled = [];
  for (const fen of SEEDS) {
    let chess;
    try {
      chess = new Chess(fen);
    } catch {
      continue;
    }
    const analysis = analyzeRoot(chess, { depth: 3, quiescence: 2, timeBudgetMs: 2500 });
    const best = analysis.moves[0];
    const second = analysis.moves[1];
    if (!best || !second) continue;
    if (best.mateIn === 1 || second.mateIn === 1) continue;
    const gap = best.cp - second.cp;
    if (gap < 200) continue;
    labelled.push({ fen, bestSan: best.san, gap, legal: analysis.moves.length });
  }
  return labelled;
}

/** Positions where exactly one shortlisted candidate hands material to the opponent. */
function labelBlunder() {
  const labelled = [];
  for (const fen of SEEDS) {
    let chess;
    try {
      chess = new Chess(fen);
    } catch {
      continue;
    }
    const analysis = analyzeRoot(chess, { depth: 3, quiescence: 2, timeBudgetMs: 2500 });
    if (analysis.moves.length < 6) continue;
    const best = analysis.moves[0];
    const worst = analysis.moves[analysis.moves.length - 1];
    if (!best || !worst || best.mateIn !== null || worst.mateIn !== null) continue;
    // A clear blunder: the worst move in the list is at least a piece worse.
    if (worst.cp - best.cp > -300) continue;
    labelled.push({ fen, bestSan: best.san, worstSan: worst.san, drop: best.cp - worst.cp, legal: analysis.moves.length });
  }
  return labelled;
}

// ---------------------------------------------------------------------------
// asking Jev: the same shape the game uses
// ---------------------------------------------------------------------------

/**
 * Ask Jev to choose among a shortlist, optionally scoring dimensions too.
 * @returns {{choice: string|null, probabilities: object, scores: Record<string, Record<string, number>>, raw: object}}
 */
async function askCandidates(chess, { dims = [], includeBoards = true, exposeCaptureEvidence = false, limit = 8, depth = 3, includeSan = [] } = {}) {
  const analysis = analyzeRoot(chess, { depth, quiescence: 2, timeBudgetMs: 2500 });
  if (analysis.moves.length === 0) throw new Error("no legal moves in this position (it is already over)");
  const shortlist = analysis.moves.slice(0, limit);
  // Some experiments need a specific move on the list even when the search ranks it
  // last — the blunder experiment is only meaningful if Jev can actually see the blunder.
  for (const san of includeSan) {
    if (shortlist.some((move) => move.san === san)) continue;
    const found = analysis.moves.find((move) => move.san === san);
    if (found) shortlist.push(found);
  }
  const candidates = shortlist.map((move, index) => ({ id: `c${index + 1}`, ...move }));
  const state = buildJevState({
    chess,
    candidates: candidates.map((candidate) => ({ id: candidate.id, move: candidate.move })),
    includeBoards,
    exposeCaptureEvidence,
  });
  const ctx = {
    side: { name: chess.turn() === "w" ? "White" : "Black" },
    opponent: { name: chess.turn() === "w" ? "Black" : "White" },
  };
  const { questions } = buildCandidateQuestions(
    candidates.map((candidate) => ({ id: candidate.id, san: candidate.san, description: candidate.san, summary: candidate.san })),
    { dims },
    ctx,
  );
  const response = await client.systemOne({ state, questions });
  const validKeys = candidates.map((candidate) => `${candidate.id} ${candidate.san}`);
  const parsed = readChoiceAnswer(response.answers?.best_move, validKeys);
  const chosenSan = parsed.choice ? parsed.choice.split(" ").slice(1).join(" ") : null;

  const scores = {};
  for (const candidate of candidates) {
    scores[candidate.san] = {};
    for (const dim of dims) {
      const definition = DIMENSIONS[dim];
      const value = readScoreAnswer(response.answers?.[`cand_${candidate.id}_${dim}`], definition.levels(ctx).length);
      if (value !== null) scores[candidate.san][dim] = value;
    }
  }
  return {
    choice: chosenSan,
    probabilities: parsed.probabilities,
    invalid: parsed.invalid,
    scores,
    searchTop: analysis.moves[0].san,
    searchOrder: analysis.moves.map((move) => move.san),
    searchCp: Object.fromEntries(analysis.moves.map((move) => [move.san, move.cp])),
    shortlist: candidates.map((candidate) => candidate.san),
    usage: response.usage,
    mock: Boolean(response.mock),
  };
}

function rate(hits, total) {
  return total === 0 ? 0 : hits / total;
}

function table(rows) {
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => String(row[index]).length)));
  return rows.map((row) => row.map((cell, index) => String(cell).padEnd(widths[index])).join("  ")).join("\n");
}

// ---------------------------------------------------------------------------
// experiment 1 — mate in one
// ---------------------------------------------------------------------------

async function experimentMateInOne() {
  const cases = labelMate();
  console.log(`1. Mate in one — ${cases.length} labelled position(s)`);
  if (cases.length === 0) {
    console.log("   (no seed position has a mate in one; skipped)\n");
    return { cases: 0 };
  }
  const rows = [["position (fen)", "mating move", "Jev chose", "hit"]];
  let hits = 0;
  for (const testCase of cases) {
    const result = await askCandidates(new Chess(testCase.fen), { dims: ["quality"], limit: 8 });
    const hit = result.choice === testCase.bestSan;
    if (hit) hits += 1;
    rows.push([testCase.fen.slice(0, 34), testCase.bestSan, result.choice ?? "(none)", hit ? "yes" : "no"]);
  }
  console.log(table(rows));
  console.log(`   accuracy: ${hits}/${cases.length} (${(rate(hits, cases.length) * 100).toFixed(0)}%)\n`);
  return { cases: cases.length, hits, accuracy: rate(hits, cases.length) };
}

// ---------------------------------------------------------------------------
// experiment 2 — winning material
// ---------------------------------------------------------------------------

async function experimentMaterial() {
  const cases = labelMaterial();
  console.log(`2. Winning material — ${cases.length} position(s) where the best move is ≥200cp clear`);
  if (cases.length === 0) {
    console.log("   (none of the seeds has a clear material win; skipped)\n");
    return { cases: 0 };
  }
  const rows = [["position (fen)", "best move", "gap (cp)", "Jev chose", "hit"]];
  let hits = 0;
  for (const testCase of cases) {
    const result = await askCandidates(new Chess(testCase.fen), { dims: ["quality", "safety"], limit: 8 });
    const hit = result.choice === testCase.bestSan;
    if (hit) hits += 1;
    rows.push([testCase.fen.slice(0, 34), testCase.bestSan, testCase.gap, result.choice ?? "(none)", hit ? "yes" : "no"]);
  }
  console.log(table(rows));
  console.log(`   accuracy: ${hits}/${cases.length} (${(rate(hits, cases.length) * 100).toFixed(0)}%)\n`);
  return { cases: cases.length, hits, accuracy: rate(hits, cases.length) };
}

// ---------------------------------------------------------------------------
// experiment 3 — can Jev see a blunder when it is on the list?
// ---------------------------------------------------------------------------

async function experimentBlunderDetection() {
  const cases = labelBlunder();
  console.log(`3. Blunder detection — ${cases.length} position(s) with one clearly bad candidate`);
  if (cases.length === 0) {
    console.log("   (no seed produced a clear blunder candidate; skipped)\n");
    return { cases: 0 };
  }
  const rows = [["position", "bad move", "safety", "best move", "safety", "scored lower?", "also chose it?"]];
  let caught = 0;
  let choseBad = 0;
  for (const testCase of cases) {
    // The blunder has to be on the list for Jev to be able to judge it, so it is added
    // explicitly even though the search ranks it near the bottom.
    const result = await askCandidates(new Chess(testCase.fen), { dims: ["safety"], limit: 8, includeSan: [testCase.worstSan] });
    const bad = result.scores[testCase.worstSan]?.safety;
    const good = result.scores[testCase.bestSan]?.safety;
    const caughtIt = typeof bad === "number" && typeof good === "number" && bad < good;
    const pickedIt = result.choice === testCase.worstSan;
    if (caughtIt) caught += 1;
    if (pickedIt) choseBad += 1;
    rows.push([
      testCase.fen.slice(0, 26),
      testCase.worstSan,
      bad === undefined ? "n/a" : bad.toFixed(2),
      testCase.bestSan,
      good === undefined ? "n/a" : good.toFixed(2),
      caughtIt ? "yes" : "no",
      pickedIt ? "YES (blunder)" : "no",
    ]);
  }
  console.log(table(rows));
  console.log(`   Jev scored the blunder as less safe in ${caught}/${cases.length} (${(rate(caught, cases.length) * 100).toFixed(0)}%)`);
  console.log(`   Jev actually chose the blunder in ${choseBad}/${cases.length} (${(rate(choseBad, cases.length) * 100).toFixed(0)}%)\n`);
  return { cases: cases.length, caught, choseBad, accuracy: rate(caught, cases.length), blunderRate: rate(choseBad, cases.length) };
}

// ---------------------------------------------------------------------------
// experiment 4 — agreement with a 3-ply search
// ---------------------------------------------------------------------------

async function experimentAgreement() {
  console.log(`4. Agreement with the search — ${SEEDS.length} seed position(s)`);
  const rows = [["position", "search best", "Jev best", "agreed", "quality corr."]];
  let agreed = 0;
  let usable = 0;
  const correlations = [];
  for (const fen of SEEDS) {
    let chess;
    try {
      chess = new Chess(fen);
    } catch {
      continue;
    }
    let result;
    try {
      result = await askCandidates(chess, { dims: ["quality"], limit: 8 });
    } catch (error) {
      // A finished or degenerate position is skipped, not fatal to the experiment.
      rows.push([fen.slice(0, 30), "n/a", `skipped: ${error.message}`, "no", "n/a"]);
      continue;
    }
    usable += 1;
    const same = result.choice === result.searchTop;
    if (same) agreed += 1;
    const paired = result.shortlist
      .filter((san) => typeof result.scores[san]?.quality === "number")
      .map((san) => ({ quality: result.scores[san].quality, cp: result.searchCp[san] }));
    const correlation = spearman(
      paired.map((entry) => entry.quality),
      paired.map((entry) => entry.cp),
    );
    if (correlation !== null) correlations.push(correlation);
    rows.push([fen.slice(0, 30), result.searchTop, result.choice ?? "(none)", same ? "yes" : "no", correlation === null ? "n/a" : correlation.toFixed(2)]);
  }
  console.log(table(rows));
  const meanCorrelation = correlations.length ? correlations.reduce((sum, value) => sum + value, 0) / correlations.length : null;
  console.log(`   top-1 agreement: ${agreed}/${usable} (${(rate(agreed, usable) * 100).toFixed(0)}%)`);
  console.log(
    `   mean Spearman correlation between Jev's quality scores and search centipawns: ${meanCorrelation === null ? "n/a" : meanCorrelation.toFixed(2)}`,
  );
  console.log(`   (0 means Jev's ranking is unrelated to the search's; 1 means identical ordering)\n`);
  return { cases: usable, agreed, accuracy: rate(agreed, usable), meanCorrelation };
}

// ---------------------------------------------------------------------------
// experiment 5 — does the shape of the state matter?
// ---------------------------------------------------------------------------

async function experimentPromptShape() {
  const cases = [...labelMate(), ...labelMaterial()].slice(0, 12);
  console.log(`5. Prompt shape — ${cases.length} labelled position(s), same question four ways`);
  if (cases.length === 0) {
    console.log("   (no labelled positions; skipped)\n");
    return {};
  }
  const variants = [
    { name: "boards only", includeBoards: true, exposeCaptureEvidence: false },
    { name: "boards + captures", includeBoards: true, exposeCaptureEvidence: true },
    { name: "no boards", includeBoards: false, exposeCaptureEvidence: false },
    { name: "no boards + captures", includeBoards: false, exposeCaptureEvidence: true },
  ];
  const rows = [["state shape", "hits", "accuracy"]];
  const summary = {};
  for (const variant of variants) {
    let hits = 0;
    for (const testCase of cases) {
      const result = await askCandidates(new Chess(testCase.fen), {
        dims: ["quality"],
        limit: 8,
        includeBoards: variant.includeBoards,
        exposeCaptureEvidence: variant.exposeCaptureEvidence,
      });
      if (result.choice === testCase.bestSan) hits += 1;
    }
    summary[variant.name] = { hits, cases: cases.length, accuracy: rate(hits, cases.length) };
    rows.push([variant.name, `${hits}/${cases.length}`, `${(rate(hits, cases.length) * 100).toFixed(0)}%`]);
  }
  console.log(table(rows));
  console.log("   This is the experiment that decides the defaults in src/jev/state.js.\n");
  return summary;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Spearman rank correlation; null when there is nothing to correlate. */
function spearman(a, b) {
  if (a.length !== b.length || a.length < 3) return null;
  const rank = (values) => {
    const order = values.map((value, index) => ({ value, index })).sort((x, y) => x.value - y.value);
    const ranks = new Array(values.length);
    for (let i = 0; i < order.length; i += 1) ranks[order[i].index] = i;
    return ranks;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const meanA = ra.reduce((sum, value) => sum + value, 0) / n;
  const meanB = rb.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = ra[i] - meanA;
    const db = rb[i] - meanB;
    numerator += da * db;
    sumA += da * da;
    sumB += db * db;
  }
  if (sumA === 0 || sumB === 0) return null;
  return numerator / Math.sqrt(sumA * sumB);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const experiments = {
  "mate-in-one": experimentMateInOne,
  material: experimentMaterial,
  "blunder-detection": experimentBlunderDetection,
  agreement: experimentAgreement,
  "prompt-shape": experimentPromptShape,
};

for (const [name, run] of Object.entries(experiments)) {
  if (ONLY && ONLY !== name) continue;
  try {
    results.experiments[name] = await run();
  } catch (error) {
    console.log(`   ERROR in ${name}: ${error.message}\n`);
    results.experiments[name] = { error: error.message };
  }
}

results.finishedAt = new Date().toISOString();
results.usage = client.stats ?? null;

await mkdir(join(ROOT, "experiments"), { recursive: true });
const outFile = join(ROOT, "experiments", `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(outFile, JSON.stringify(results, null, 2), "utf8");

console.log(`Written to ${outFile}`);
if (FORCE_MOCK) {
  console.log("These numbers came from the mock client and say nothing about Jev. Set TYPESAFE_API_KEY and re-run.");
}
