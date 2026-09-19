/**
 * Match runner and "does Jev add anything?" measurement.
 *
 * The app can play Jev against Jev with different strategies, which makes the project's
 * central question measurable rather than a matter of opinion:
 *
 *   Is a strategy that lets Jev judge the move actually better than the code search alone?
 *
 * This tool plays whole games between two strategy configurations, unattended, and reports:
 *
 *   - the match score, by colour (so a first-move bias cannot hide), plus game lengths and
 *     termination reasons;
 *   - an **impact metric**: every time a seat's composite pick differed from the code
 *     search's own top move, both moves are re-evaluated with a *deeper, independent*
 *     reference search. If Jev's deviation scores better it counts as a win for the
 *     judgement, worse as a loss. That is the number that says whether Jev is earning its
 *     place, and it is computed by code, not by asking a model to grade itself;
 *   - fallbacks and errors, which should be zero: a healthy run means Jev never had to be
 *     rescued.
 *
 * Usage:
 *   node tools/selfplay.mjs                                  # 2 games, balanced vs code-only
 *   node tools/selfplay.mjs --games=6 --a=balanced --b=pure-jev
 *   node tools/selfplay.mjs --budget=300 --reference-budget=1200 --fen="..."
 *   node tools/selfplay.mjs --mock                            # mechanics only, meaningless numbers
 *
 * Cost: a game is roughly (plies × budget) for the seats plus one reference evaluation per
 * deviating move. Two games at the defaults take about a minute and cost well under a cent.
 * Writes experiments/selfplay-<timestamp>.json.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Chess } from "../src/engine/chess.js";
import { analyzeRoot, MATE_THRESHOLD } from "../src/engine/search.js";
import { Game } from "../src/game.js";
import { loadDotEnv } from "../src/env.js";
import { resolveApiKey, resolveSecret } from "../src/win-key.js";
import { createJevClient } from "../src/jev/client.js";
import { DEFAULT_MODEL as DEFAULT_GEMINI_MODEL, createLlmClient } from "../src/llm/client.js";
import { resolveStrategy, getPreset, PRESETS } from "../src/strategies.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
loadDotEnv(join(ROOT, ".env"));

const flag = (name, fallback = null) => {
  const arg = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const GAMES = Math.max(1, Number(flag("games", 2)));
const SEAT_A = flag("a", "balanced");
const SEAT_B = flag("b", "code-only");
const BUDGET_MS = Math.max(50, Number(flag("budget", 300)));
const REFERENCE_BUDGET_MS = Math.max(BUDGET_MS + 100, Number(flag("reference-budget", 1200)));
const REFERENCE_DEPTH = Math.max(2, Number(flag("reference-depth", 4)));
const MAX_REFERENCE_MOVES = Math.max(0, Number(flag("reference-moves", 12)));
const MAX_PLIES = Math.max(20, Number(flag("max-plies", 200)));
const START_FEN = flag("fen", null);
const MOCK = has("mock");
/** e.g. --weights="search=0.6,quality=0.15,safety=0.1,activity=0.05" for seat A only. */
const WEIGHTS = (() => {
  const raw = flag("weights", null);
  if (!raw) return null;
  const parsed = {};
  for (const pair of String(raw).split(",")) {
    const [key, value] = pair.split("=").map((part) => part.trim());
    const numeric = Number(value);
    if (key && Number.isFinite(numeric)) parsed[key] = numeric;
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
})();

for (const id of [SEAT_A, SEAT_B]) {
  if (!getPreset(id)) {
    // Derived from the presets themselves: a hand-written list here has already gone stale once.
    console.error(`Unknown strategy "${id}". Available: ${PRESETS.map((preset) => preset.id).join(", ")}`);
    process.exit(2);
  }
}

const { key: API_KEY, source: KEY_SOURCE } = await resolveApiKey();
const forceMock = MOCK || !API_KEY;

// The strategist is a second model, so a match involving a planning seat needs it wired in here
// too — a planning seat with no planner would quietly play as its bare preset, and the run would
// measure nothing while looking like it had.
const { key: GEMINI_KEY, source: GEMINI_SOURCE } = await resolveSecret("gemini");
const llmClient =
  GEMINI_KEY || MOCK
    ? createLlmClient({
        apiKey: GEMINI_KEY,
        forceMock: MOCK || !GEMINI_KEY,
        model: process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
      })
    : null;
const planningSeats = [SEAT_A, SEAT_B].filter((id) => getPreset(id)?.llmPlan);
if (planningSeats.length > 0 && (!llmClient || llmClient.mock) && !MOCK) {
  console.error(
    `Seat(s) ${planningSeats.join(", ")} plan with a reasoning model, but no Gemini key is available ` +
      `(source: ${GEMINI_SOURCE}). The seats would fall back to their presets and the match would ` +
      "measure nothing. Store a key (`npm run key:set -- gemini`) or pass --mock to accept fake plans.",
  );
  process.exit(2);
}

const jevClient = createJevClient({ apiKey: API_KEY, forceMock, model: process.env.TYPESAFE_MODEL ?? "jev-latest", maxAttempts: 3 });
const MOCK_MODE = Boolean(jevClient.mock);

const client = () => jevClient;

// ---------------------------------------------------------------------------
// one game
// ---------------------------------------------------------------------------

/** Position after `ply` plies, or the start position for ply 0. */
function fenBefore(history, startFen, ply) {
  if (ply <= 0) return startFen;
  return history[ply - 1]?.fenAfter ?? startFen;
}

/**
 * Re-evaluate a move that deviated from the search's own choice, using a deeper reference
 * search. Returns "win" when Jev's pick scores better than the move the search would have
 * played, "loss" when worse, "neutral" when the difference is noise.
 */
function judgeDeviation(chess, chosenSan, searchTopSan, bestCpAtSeatDepth) {
  const reference = analyzeRoot(chess, {
    depth: REFERENCE_DEPTH,
    quiescence: 2,
    timeBudgetMs: REFERENCE_BUDGET_MS,
  });
  const find = (san) => reference.moves.find((move) => move.san === san);
  const chosen = find(chosenSan);
  const top = find(searchTopSan);
  if (!chosen || !top) return { outcome: "unknown", chosenCp: null, topCp: null, delta: null, depth: reference.depth };
  const delta = chosen.cp - top.cp;
  const noise = 20; // centipawns: below this the two moves are not meaningfully different
  const outcome = delta > noise ? "win" : delta < -noise ? "loss" : "neutral";
  return { outcome, chosenCp: chosen.cp, topCp: top.cp, delta, depth: reference.depth, bestCpAtSeatDepth };
}

async function playGame({ gameNumber, seatA, seatB, aPlaysWhite }) {
  const seatAConfig = { strategyId: SEAT_A, ...(WEIGHTS ? { weights: WEIGHTS } : {}) };
  const playerConfigs = aPlaysWhite
    ? { w: { ...seatAConfig, timeBudgetMs: BUDGET_MS }, b: { strategyId: SEAT_B, timeBudgetMs: BUDGET_MS } }
    : { w: { strategyId: SEAT_B, timeBudgetMs: BUDGET_MS }, b: { ...seatAConfig, timeBudgetMs: BUDGET_MS } };

  const game = new Game({
    id: `selfplay_${gameNumber}_${Math.random().toString(36).slice(2, 7)}`,
    mode: "jev-vs-jev",
    fen: START_FEN ?? undefined,
    timeControl: null,
    playerConfigs,
    jevClient: client(),
    llmClient,
    modelName: process.env.TYPESAFE_MODEL ?? "jev-latest",
    hasApiKey: Boolean(API_KEY) && !MOCK_MODE,
    aiMoveDelayMs: 0,
  });

  const startedAt = Date.now();
  const deadline = startedAt + 15 * 60 * 1000;
  while (!game.snapshot().status.over && game.history.length < MAX_PLIES && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const finished = game.snapshot().status.over;
  const status = game.snapshot().status;
  const history = game.history;
  const startFen = game.snapshot().startFen;

  // --- per-move metrics ----------------------------------------------------
  const moves = history.filter((record) => record.jev);
  const deviating = moves.filter((record) => record.jev.searchRankOfChosen > 1);
  // A "fallback" means a pipeline that was supposed to consult Jev could not use its
  // answer. `requests === 0` alone is not a fallback: the code-only baseline never asks
  // (this mistake made the first run report 75 phantom fallbacks).
  const needsJev = (record) => record.jev.pipeline !== "search-only";
  const fellBack = (record) =>
    (record.jev.errors?.length ?? 0) > 0 ||
    (needsJev(record) && record.jev.requests === 0) ||
    (needsJev(record) &&
      (record.jev.notes ?? []).some((note) => /no usable|was unavailable|not one of the candidates|search score decided/i.test(note)));
  const fallbacks = moves.filter(fellBack);

  const referenceResults = [];
  if (MAX_REFERENCE_MOVES > 0) {
    // Evenly sample the deviations rather than always judging the opening.
    const step = Math.max(1, Math.ceil(deviating.length / MAX_REFERENCE_MOVES));
    for (let index = 0; index < deviating.length; index += step) {
      const record = deviating[index];
      const chess = new Chess(fenBefore(history, startFen, record.ply - 1));
      const searchTopSan = record.jev.search?.bestSan ?? null;
      if (!searchTopSan) continue;
      referenceResults.push({
        ply: record.ply,
        color: record.color,
        chosenSan: record.san,
        searchTopSan,
        ...judgeDeviation(chess, record.san, searchTopSan, record.jev.search?.bestCp ?? null),
      });
    }
  }

  const outcomeForA = (() => {
    if (!finished || !status.result) return "unfinished";
    if (status.result === "1/2-1/2") return "draw";
    const winner = status.result === "1-0" ? "w" : "b";
    const aColor = aPlaysWhite ? "w" : "b";
    return winner === aColor ? "a" : "b";
  })();

  game.dispose();

  return {
    gameNumber,
    aPlaysWhite,
    finished,
    result: status.result ?? null,
    reason: status.reason ?? (finished ? null : "ply cap or timeout"),
    plies: history.length,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    outcomeForA,
    moves: moves.length,
    deviating: deviating.length,
    deviationRate: moves.length ? deviating.length / moves.length : 0,
    fallbacks: fallbacks.length,
    referenceResults,
    usage: moves.reduce(
      (sum, record) => ({ input: sum.input + (record.jev.usage?.input_tokens ?? 0), requests: sum.requests + (record.jev.requests ?? 0) }),
      { input: 0, requests: 0 },
    ),
    // The strategy layer's own cost, kept separate from Jev's: the point of a planning seat is that
    // it should pay for itself, and that argument needs both numbers.
    movesUnderPlan: moves.filter((record) => record.jev.llm?.plan).length,
    planReviews: game.snapshot().llm.reviews ?? 0,
    planCostUsd: moves.reduce((sum, record) => sum + (record.jev.llm?.costUsd ?? 0), 0),
    planTokens: moves.reduce((sum, record) => sum + (record.jev.llm?.usage?.inputTokens ?? 0) + (record.jev.llm?.usage?.outputTokens ?? 0), 0),
    finalFen: game.snapshot().fen,
    startFen,
  };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

console.log("JevChess self-play");
console.log(`  seat A: ${SEAT_A}   seat B: ${SEAT_B}`);
console.log(`  games:  ${GAMES}   search budget: ${BUDGET_MS} ms/move   reference: depth ${REFERENCE_DEPTH}, ${REFERENCE_BUDGET_MS} ms`);
console.log(`  model:  ${process.env.TYPESAFE_MODEL ?? "jev-latest"}   key from: ${KEY_SOURCE}`);
if (MOCK_MODE) {
  console.log("  [MOCK: Jev's answers are pseudo-random here, so the impact numbers below measure the");
  console.log("   instrument, not the model. A negative impact is the expected and correct result.]");
}
console.log("");

await mkdir(join(ROOT, "experiments"), { recursive: true });
const games = [];
for (let index = 0; index < GAMES; index += 1) {
  const aPlaysWhite = index % 2 === 0;
  process.stdout.write(`  game ${index + 1}/${GAMES} (${SEAT_A} as ${aPlaysWhite ? "White" : "Black"}) … `);
  const result = await playGame({ gameNumber: index + 1, seatA: { strategyId: SEAT_A }, seatB: { strategyId: SEAT_B }, aPlaysWhite });
  games.push(result);
  console.log(
    `${result.finished ? `${result.result} by ${result.reason}` : "unfinished"} in ${result.plies} plies ` +
      `(${result.seconds}s, ${result.deviating}/${result.moves} deviations from the search)`,
  );
}

// --- aggregate -------------------------------------------------------------

const scoreForA = games.reduce((sum, game) => sum + (game.outcomeForA === "a" ? 1 : game.outcomeForA === "draw" ? 0.5 : 0), 0);
const wins = games.filter((game) => game.outcomeForA === "a").length;
const draws = games.filter((game) => game.outcomeForA === "draw").length;
const losses = games.filter((game) => game.outcomeForA === "b").length;
const unfinished = games.filter((game) => game.outcomeForA === "unfinished").length;

const allReferences = games.flatMap((game) => game.referenceResults);
const judged = allReferences.filter((entry) => entry.outcome === "win" || entry.outcome === "loss" || entry.outcome === "neutral");
const impactWins = judged.filter((entry) => entry.outcome === "win").length;
const impactLosses = judged.filter((entry) => entry.outcome === "loss").length;
const impactNeutral = judged.filter((entry) => entry.outcome === "neutral").length;
const meanDelta = judged.length ? judged.reduce((sum, entry) => sum + (entry.delta ?? 0), 0) / judged.length : 0;

const totalMoves = games.reduce((sum, game) => sum + game.moves, 0);
const totalDeviations = games.reduce((sum, game) => sum + game.deviating, 0);
const totalFallbacks = games.reduce((sum, game) => sum + game.fallbacks, 0);
const totalInputTokens = games.reduce((sum, game) => sum + game.usage.input, 0);
const totalRequests = games.reduce((sum, game) => sum + game.usage.requests, 0);

const reasonCounts = {};
for (const game of games) reasonCounts[game.reason ?? "unfinished"] = (reasonCounts[game.reason ?? "unfinished"] ?? 0) + 1;

console.log("\nMatch");
console.log(`  ${SEAT_A}: ${wins} win(s), ${draws} draw(s), ${losses} loss(es)${unfinished ? `, ${unfinished} unfinished` : ""}  →  score ${scoreForA}/${games.length}`);
console.log(`  ${SEAT_B}: ${losses} win(s), ${draws} draw(s), ${wins} loss(es)`);
console.log(`  terminations: ${Object.entries(reasonCounts).map(([reason, count]) => `${reason} ×${count}`).join(", ")}`);
console.log(`  average game: ${(games.reduce((sum, game) => sum + game.plies, 0) / games.length).toFixed(1)} plies`);

console.log("\nDid Jev's judgement help?");
console.log(`  deviations from the search's own top move: ${totalDeviations}/${totalMoves} plies (${((totalDeviations / Math.max(1, totalMoves)) * 100).toFixed(0)}%)`);
if (judged.length === 0) {
  console.log("  no deviations were re-evaluated (nothing to judge)");
} else {
  console.log(`  of ${judged.length} re-evaluated, judged by a deeper ${REFERENCE_DEPTH}-ply search:`);
  console.log(`    better than the search's move: ${impactWins} (${((impactWins / judged.length) * 100).toFixed(0)}%)`);
  console.log(`    worse:                         ${impactLosses} (${((impactLosses / judged.length) * 100).toFixed(0)}%)`);
  console.log(`    indistinguishable (±20cp):     ${impactNeutral} (${((impactNeutral / judged.length) * 100).toFixed(0)}%)`);
  console.log(`    mean centipawn difference:     ${meanDelta >= 0 ? "+" : ""}${meanDelta.toFixed(1)}`);
  console.log(
    `    verdict: ${impactWins > impactLosses ? "Jev's judgement is adding value" : impactWins < impactLosses ? "Jev's judgement is costing material" : "no measurable effect"}`,
  );
}
console.log(`  moves that needed a fallback or reported an error: ${totalFallbacks} (must be 0)`);
console.log(`  Jev requests: ${totalRequests}, input tokens: ${totalInputTokens} ≈ $${((totalInputTokens / 1_000_000) * 0.042).toFixed(4)} for the whole run`);
const totalPlanMoves = games.reduce((sum, game) => sum + game.movesUnderPlan, 0);
const totalPlanReviews = games.reduce((sum, game) => sum + game.planReviews, 0);
const totalPlanCost = games.reduce((sum, game) => sum + game.planCostUsd, 0);
const totalPlanTokens = games.reduce((sum, game) => sum + game.planTokens, 0);
if (totalPlanReviews > 0 || totalPlanMoves > 0) {
  console.log(
    `  strategist: ${totalPlanReviews} review(s) for ${totalMoves} plies (one per ${(totalMoves / Math.max(1, totalPlanReviews)).toFixed(1)}), ` +
      `${totalPlanMoves} moves played under a plan, ${totalPlanTokens} tokens ≈ $${totalPlanCost.toFixed(4)}`,
  );
  console.log(`  combined cost of the run: ≈ $${(((totalInputTokens / 1_000_000) * 0.042) + totalPlanCost).toFixed(4)}`);
}

const report = {
  startedAt: new Date().toISOString(),
  mock: MOCK_MODE,
  seatA: SEAT_A,
  seatB: SEAT_B,
  budgetMs: BUDGET_MS,
  referenceBudgetMs: REFERENCE_BUDGET_MS,
  referenceDepth: REFERENCE_DEPTH,
  match: { games: games.length, wins, draws, losses, unfinished, scoreForA, terminations: reasonCounts },
  impact: {
    moves: totalMoves,
    deviations: totalDeviations,
    judged: judged.length,
    better: impactWins,
    worse: impactLosses,
    neutral: impactNeutral,
    meanDeltaCp: Math.round(meanDelta * 10) / 10,
  },
  fallbacks: totalFallbacks,
  usage: { requests: totalRequests, inputTokens: totalInputTokens, costUsd: (totalInputTokens / 1_000_000) * 0.042 },
  strategist: { reviews: totalPlanReviews, movesUnderPlan: totalPlanMoves, tokens: totalPlanTokens, costUsd: totalPlanCost },
  games,
};

const outFile = join(ROOT, "experiments", `selfplay-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(outFile, JSON.stringify(report, null, 2), "utf8");
console.log(`\nWritten to ${outFile}`);

if (totalFallbacks > 0) {
  console.log("\nWARNING: some moves needed a fallback; check the games above for errors.");
  process.exitCode = 1;
}
if (MOCK_MODE) {
  console.log("Numbers came from the mock client: they say nothing about Jev's chess. Store a key to run this for real.");
}
