/**
 * The move-selection pipelines.
 *
 * Code owns everything checkable: which moves are legal, what the board looks like
 * afterwards, how much material is on it, and a shallow search that keeps outright
 * blunders out of the shortlist. Jev owns the judgement: which move is best, how safe
 * it is, how active it is, how much it threatens the enemy king.
 *
 * Every pipeline returns `{ move, record }`, where `record` is the JevMove object the
 * UI renders (see CONTRACT.md). Nothing here throws for a bad answer from Jev: a chess
 * game must keep going, so every failure degrades to something legal and is reported in
 * `record.notes` / `record.errors`.
 */

import { analyzeRoot, cpToUnit, PIECE_VALUE, MATE_THRESHOLD } from "../engine/search.js";
import { buildJevState, buildAuditState, sideName, otherColor, describeMove } from "./state.js";
import {
  buildCandidateQuestions,
  buildAssessmentQuestions,
  buildAuditQuestions,
  DIMENSIONS,
  readChoiceAnswer,
  readNoulAnswer,
  readScoreAnswer,
  STRATEGY_TUNING,
  clamp01,
} from "./questions.js";

const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

/**
 * Choose a move for the side to move.
 *
 * @param {object} opts
 * @param {object} opts.chess        position (mutated and restored internally)
 * @param {object} opts.strategy     resolved strategy from resolveStrategy()
 * @param {object} opts.jevClient    TypeSafeClient or MockTypeSafeClient (may be null for `search-only`)
 * @param {string[]} [opts.lastMovesSan]
 * @param {(event: object) => void} [opts.onEvent]  progress callback for the UI
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{move: object|null, record: object|null}>}
 */
export async function selectMove({ chess, strategy, jevClient, lastMovesSan = [], onEvent = null, signal = null }) {
  const legal = chess.moves();
  if (legal.length === 0) return { move: null, record: null };

  const emit = (event) => {
    if (onEvent) {
      try {
        onEvent(event);
      } catch {
        /* a progress callback must never break a move */
      }
    }
  };

  switch (strategy.pipeline) {
    case "search-only":
      return searchOnly({ chess, strategy, lastMovesSan });
    case "pure-choice":
      return pureChoice({ chess, strategy, jevClient, lastMovesSan, emit, signal });
    case "nominate-verify":
      return nominateVerify({ chess, strategy, jevClient, lastMovesSan, emit, signal });
    case "shortlist-composite":
    default:
      return shortlistComposite({ chess, strategy, jevClient, lastMovesSan, emit, signal });
  }
}

// ---------------------------------------------------------------------------
// 1. shortlist-composite — the "best" pipeline
// ---------------------------------------------------------------------------

async function shortlistComposite({ chess, strategy, jevClient, lastMovesSan, emit, signal }) {
  const startedAt = Date.now();
  const turn = chess.turn();
  const ctx = makeContext(turn);

  emit({ type: "stage", stage: "search", message: `Searching ${strategy.searchDepth} ply over ${chess.moves().length} legal moves` });
  const analysis = analyzeRoot(chess, {
    depth: strategy.searchDepth,
    quiescence: strategy.quiescence,
    timeBudgetMs: strategy.timeBudgetMs,
  });
  const limit = Math.max(1, Math.min(strategy.candidateLimit ?? 12, analysis.moves.length));
  const shortlist = analysis.moves.slice(0, limit);

  const candidates = shortlist.map((entry, index) => ({ id: `c${index + 1}`, ...entry }));
  const searchCpBySan = Object.fromEntries(analysis.moves.map((entry) => [entry.san, entry.cp]));

  const state = buildJevState({
    chess,
    candidates: candidates.map((candidate) => ({ id: candidate.id, move: candidate.move })),
    lastMovesSan,
    includeBoards: strategy.includeBoards !== false,
    exposeCaptureEvidence: Boolean(strategy.exposeCaptureEvidence),
    includeSearchHints: Boolean(strategy.includeSearchHints),
    searchCpBySan,
  });

  const candidateMeta = candidates.map((candidate) => ({
    id: candidate.id,
    san: candidate.san,
    description: describeMove(chess, candidate.move),
    summary: summarizeCandidate(chess, candidate),
  }));

  const { questions, index } = buildCandidateQuestions(candidateMeta, { dims: strategy.dims }, ctx);
  Object.assign(questions, buildAssessmentQuestions(ctx));

  emit({ type: "stage", stage: "jev", message: `Asking Jev to judge ${candidates.length} candidates (${Object.keys(questions).length} questions)` });

  let response = null;
  const errors = [];
  try {
    response = await jevClient.systemOne({ state, questions, signal });
  } catch (error) {
    errors.push(`Jev did not answer: ${error.message}`);
  }

  const { dimsByCandidate, choiceScores, assessment, usage, model, mock } = readCompositeAnswers(response, { candidates, index, ctx });

  // Composite score per candidate.
  const scored = candidates.map((candidate) => {
    const values = { search: searchUnit(candidate.cp, analysis.bestCp, candidate.mateIn) };
    if (choiceScores[candidate.id] !== undefined) values.choice = choiceScores[candidate.id];
    for (const [dim, value] of Object.entries(dimsByCandidate[candidate.id] ?? {})) values[dim] = value;
    const composite = combine(values, strategy.weights);
    return { ...candidate, values, composite };
  });

  // Did Jev contribute anything usable? If not, the search's own ranking must decide, with no
  // exploration: the search scores of neighbouring moves differ by a few thousandths, so
  // temperature-scaled noise (0.1 in the default preset) is far larger than the signal and
  // used to promote the second or third best move at random while the panel claimed "the
  // search's own ranking decided this move" — which simply was not true.
  const hasJevSignal =
    Object.values(dimsByCandidate).some((dims) => Object.keys(dims).length > 0) ||
    candidates.some((candidate) => choiceScores[candidate.id] !== undefined);

  const byComposite = (a, b) => b.composite - a.composite || a.rank - b.rank;
  const bestComposite = scored.reduce((best, candidate) => Math.max(best, candidate.composite), 0);
  const band = hasJevSignal ? Math.max(0, strategy.temperature ?? 0) : 0;
  const nearBest = band > 0 ? scored.filter((candidate) => candidate.composite >= bestComposite - band) : [];

  let ordered;
  let exploredFrom = null;
  if (nearBest.length > 1) {
    // Temperature is an indifference band: within it the candidates are close enough that
    // variety is worth having, so one is picked at random and the rest follow by composite.
    const picked = nearBest[Math.floor(Math.random() * nearBest.length)];
    exploredFrom = nearBest.length;
    ordered = [picked, ...scored.filter((candidate) => candidate !== picked).sort(byComposite)];
  } else {
    ordered = [...scored].sort(byComposite);
  }
  const chosen = ordered[0] ?? candidates[0];

  const notes = [];
  if (!response) notes.push("Jev was unavailable, so the search's own ranking decided this move.");
  if (exploredFrom !== null && chosen.composite < bestComposite) {
    notes.push(
      `Chose between ${exploredFrom} candidates whose composite scores were within the indifference band ` +
        `(${strategy.temperature}); the highest-scoring was ${scored.slice().sort(byComposite)[0].san}.`,
    );
  }
  if (chosen.rank !== 1) {
    notes.push(
      `Jev's judgement changed the move: the search preferred ${shortlist[0].san}, the composite chose ${chosen.san} ` +
        `(search rank ${chosen.rank}).`,
    );
  } else if (response) {
    notes.push(
      `Jev's judgement kept the search's top move ${chosen.san} after scoring ${candidates.length} candidates on ` +
        `${strategy.dims.length} ${strategy.dims.length === 1 ? "dimension" : "dimensions"}.`,
    );
  }
  if (choiceScores.invalidChoice) notes.push(`Jev nominated "${choiceScores.invalidChoice}", which is not one of the candidates; its probabilities were used instead.`);
  const missing = candidates.length * strategy.dims.length - index.filter((entry) => dimsByCandidate[entry.candidateId]?.[entry.dim] !== undefined).length;
  if (response && missing > 0) notes.push(`${missing} of Jev's dimension answers were missing or unreadable and were ignored.`);
  if (!hasJevSignal) {
    notes.push(
      response
        ? "Jev returned no usable scores for this position, so the search's ranking decided and nothing was left to chance."
        : "Nothing was left to chance: the search's ranking decided.",
    );
  }
  if (assessment?.labels?.standing) {
    notes.push(`Jev reads the position as: ${assessment.labels.standing}${assessment.labels.plan ? `, and would ${assessment.labels.plan}` : ""}.`);
  }

  // A plan, if one was in force, is part of the record: what it was, what it did to the weights,
  // what it cost and when it was last reviewed. The weights in `record.weights` are already the
  // plan-adjusted ones, so the panel shows the mix that actually decided the move.
  const planMeta = strategy.planMeta ?? null;
  const llm = strategy.plan
    ? {
        enabled: true,
        promptVersion: planMeta?.promptVersion ?? null,
        plan: strategy.plan,
        applied: planMeta?.applied ?? null,
        reason: planMeta?.reason ?? null,
        thinkingLevel: planMeta?.thinkingLevel ?? null,
        model: planMeta?.model ?? null,
        api: planMeta?.api ?? null,
        mock: Boolean(planMeta?.mock),
        usage: planMeta?.usage ?? null,
        costUsd: planMeta?.costUsd ?? null,
        elapsedMs: planMeta?.elapsedMs ?? null,
        reviewedAtPly: planMeta?.reviewedAtPly ?? null,
        pliesSinceReview: planMeta?.pliesSinceReview ?? null,
        problems: planMeta?.problems ?? [],
        warnings: planMeta?.warnings ?? [],
        notes: planMeta?.notes ?? [],
        error: planMeta?.error ?? null,
      }
    : null;
  if (llm?.notes?.length) notes.unshift(...llm.notes);
  else if (planMeta?.error) notes.unshift(`No plan this move: ${planMeta.error}`);

  const record = {
    mock: Boolean(mock),
    model: model ?? null,
    llm,
    pipeline: "shortlist-composite",
    pipelineName: "Shortlist + composite scoring",
    strategyId: strategy.id,
    strategyName: strategy.name,
    chosenSan: chosen.san,
    chosenFrom: chosen.from,
    chosenTo: chosen.to,
    chosenRank: ordered.findIndex((candidate) => candidate.id === chosen.id) + 1,
    searchRankOfChosen: chosen.rank,
    candidates: ordered.map((candidate) =>
      candidateRecord(candidate, {
        chosen,
        choiceProbabilities: choiceScores.probabilities ?? {},
        strategy,
      }),
    ),
    weights: strategy.weightsNormalized ?? strategy.weights,
    assessment,
    notes,
    audit: [],
    vetoed: [],
    usage: usage ?? { input_tokens: 0, output_tokens: 0 },
    requests: response ? 1 : 0,
    elapsedMs: Date.now() - startedAt,
    search: { depth: analysis.depth, nodes: analysis.nodes, bestCp: analysis.bestCp, bestSan: shortlist[0].san, elapsedMs: analysis.elapsedMs },
    errors,
  };

  return { move: chosen.move, record };
}

// ---------------------------------------------------------------------------
// 2. pure-choice — every legal move to Jev, no code filter
// ---------------------------------------------------------------------------

async function pureChoice({ chess, strategy, jevClient, lastMovesSan, emit, signal }) {
  const startedAt = Date.now();
  const turn = chess.turn();
  const ctx = makeContext(turn);
  const legal = chess.moves();

  // A shallow search is still run for the evaluation bar and as a legal fallback,
  // but it has no say in the choice. `record.notes` says so explicitly.
  const analysis = analyzeRoot(chess, { depth: 2, quiescence: 1, timeBudgetMs: 600, nodeBudget: 60_000 });
  const candidates = analysis.moves.map((entry, index) => ({ id: `c${index + 1}`, ...entry }));

  const state = buildJevState({
    chess,
    candidates: candidates.map((candidate) => ({ id: candidate.id, move: candidate.move })),
    lastMovesSan,
    includeBoards: false,
  });

  const candidateMeta = candidates.map((candidate) => ({
    id: candidate.id,
    san: candidate.san,
    description: describeMove(chess, candidate.move),
    summary: summarizeCandidate(chess, candidate),
  }));
  const questions = { ...buildCandidateQuestions(candidateMeta, { dims: [] }, ctx).questions, ...buildAssessmentQuestions(ctx) };

  emit({ type: "stage", stage: "jev", message: `Asking Jev to choose among all ${candidates.length} legal moves` });

  let response = null;
  const errors = [];
  try {
    response = await jevClient.systemOne({ state, questions, signal });
  } catch (error) {
    errors.push(`Jev did not answer: ${error.message}`);
  }

  const validKeys = candidates.map((candidate) => `${candidate.id} ${candidate.san}`);
  const parsed = readChoiceAnswer(response?.answers?.best_move, validKeys);
  const probabilities = mapChoiceProbabilities(parsed.probabilities, candidates);
  const assessment = readAssessment(response?.answers);

  let chosen = null;
  const notes = [];
  if (parsed.invalid) {
    notes.push(`Jev named "${parsed.invalid}", which is not a legal move here${parsed.choice ? ` — its next-best legal option was used` : ``}.`);
  }
  if (parsed.choice) chosen = candidates.find((candidate) => `${candidate.id} ${candidate.san}` === parsed.choice) ?? null;
  if (!chosen && probabilities.size > 0) {
    const best = [...probabilities.entries()].sort((a, b) => b[1] - a[1])[0][0];
    chosen = candidates.find((candidate) => candidate.id === best) ?? null;
  }
  if (!chosen) {
    chosen = candidates[0] ?? null;
    notes.push("Jev gave no usable answer for this position, so the search's top move played instead.");
  }
  notes.push("No search filtering in this pipeline: Jev's own choice played as given.");

  const ordered = [...candidates].sort((a, b) => (probabilities.get(b.id) ?? 0) - (probabilities.get(a.id) ?? 0) || a.rank - b.rank);
  const record = {
    mock: Boolean(response?.mock),
    model: response?.model ?? null,
    pipeline: "pure-choice",
    pipelineName: "Pure Jev choice",
    strategyId: strategy.id,
    strategyName: strategy.name,
    chosenSan: chosen.san,
    chosenFrom: chosen.from,
    chosenTo: chosen.to,
    chosenRank: ordered.findIndex((candidate) => candidate.id === chosen.id) + 1,
    searchRankOfChosen: chosen.rank,
    candidates: ordered.map((candidate) =>
      candidateRecord(candidate, {
        chosen,
        choiceProbabilities: Object.fromEntries(probabilities),
        strategy,
      }),
    ),
    weights: { choice: 1 },
    assessment,
    notes,
    audit: [],
    vetoed: [],
    usage: response?.usage ?? { input_tokens: 0, output_tokens: 0 },
    requests: response ? 1 : 0,
    elapsedMs: Date.now() - startedAt,
    search: { depth: analysis.depth, nodes: analysis.nodes, bestCp: analysis.bestCp, bestSan: analysis.moves[0]?.san ?? null, elapsedMs: analysis.elapsedMs, forDisplayOnly: true },
    errors,
  };

  return { move: chosen.move, record };
}

// ---------------------------------------------------------------------------
// 3. nominate-verify — Jev proposes, Jev audits, code vetoes
// ---------------------------------------------------------------------------

async function nominateVerify({ chess, strategy, jevClient, lastMovesSan, emit, signal }) {
  const startedAt = Date.now();
  const turn = chess.turn();
  const ctx = makeContext(turn);
  const analysis = analyzeRoot(chess, { depth: 2, quiescence: 1, timeBudgetMs: 600, nodeBudget: 60_000 });
  const candidates = analysis.moves.map((entry, index) => ({ id: `c${index + 1}`, ...entry }));

  const errors = [];
  const notes = [];
  const auditLog = [];
  const vetoed = [];
  let requests = 0;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let model = null;
  let mock = false;
  let assessment = null;
  // Kept across rounds so a move vetoed in an earlier round still shows the
  // probability Jev gave it at the time.
  const probabilities = new Map();
  let chosen = null;

  const maxVetoes = strategy.maxVetoes ?? STRATEGY_TUNING.maxVetoes;
  for (let round = 0; round <= maxVetoes; round += 1) {
    const pool = candidates.filter((candidate) => !vetoed.includes(candidate.san));
    if (pool.length === 0) break;

    const state = buildJevState({
      chess,
      candidates: pool.map((candidate) => ({ id: candidate.id, move: candidate.move })),
      lastMovesSan,
      includeBoards: false,
    });
    const candidateMeta = pool.map((candidate) => ({
      id: candidate.id,
      san: candidate.san,
      description: describeMove(chess, candidate.move),
      summary: summarizeCandidate(chess, candidate),
    }));
    const questions = round === 0
      ? { ...buildCandidateQuestions(candidateMeta, { dims: [] }, ctx).questions, ...buildAssessmentQuestions(ctx) }
      : buildCandidateQuestions(candidateMeta, { dims: [] }, ctx).questions;

    emit({
      type: "stage",
      stage: "jev",
      message: round === 0 ? `Asking Jev to nominate a move from ${pool.length} legal moves` : `Re-asking Jev without ${vetoed.length} vetoed move(s)`,
    });

    let response = null;
    try {
      response = await jevClient.systemOne({ state, questions, signal });
      requests += 1;
      usage = addUsage(usage, response.usage);
      model = response.model ?? model;
      mock = Boolean(response.mock) || mock;
    } catch (error) {
      errors.push(`Jev did not answer: ${error.message}`);
      break;
    }

    const validKeys = pool.map((candidate) => `${candidate.id} ${candidate.san}`);
    const parsed = readChoiceAnswer(response.answers?.best_move, validKeys);
    for (const [id, value] of mapChoiceProbabilities(parsed.probabilities, pool)) probabilities.set(id, value);
    if (round === 0) assessment = readAssessment(response.answers);
    if (parsed.invalid) notes.push(`Jev nominated "${parsed.invalid}", which is not a legal move here.`);

    let nomination = null;
    if (parsed.choice) nomination = pool.find((candidate) => `${candidate.id} ${candidate.san}` === parsed.choice) ?? null;
    if (!nomination && probabilities.size > 0) {
      const best = [...probabilities.entries()].sort((a, b) => b[1] - a[1])[0][0];
      nomination = pool.find((candidate) => candidate.id === best) ?? null;
    }
    if (!nomination) {
      notes.push("Jev gave no usable nomination, so the search's top move played instead.");
      break;
    }

    // Audit the nomination with Jev's own scrutiny.
    const auditState = buildAuditState({ chess, move: nomination.move, lastMovesSan });
    const auditQuestions = buildAuditQuestions({ san: nomination.san, side: ctx.side, opponent: ctx.opponent });
    emit({ type: "stage", stage: "audit", message: `Asking Jev to audit ${nomination.san}` });

    let auditResponse = null;
    try {
      auditResponse = await jevClient.systemOne({ state: auditState, questions: auditQuestions, signal });
      requests += 1;
      usage = addUsage(usage, auditResponse.usage);
      mock = Boolean(auditResponse.mock) || mock;
    } catch (error) {
      errors.push(`The audit request failed: ${error.message}`);
    }

    const audit = readAudit(auditResponse?.answers, ctx);
    auditLog.push(...audit.map((entry) => ({ ...entry, move: nomination.san, round: round + 1 })));

    const triggered = audit.filter((entry) => entry.veto);
    if (triggered.length === 0) {
      chosen = nomination;
      notes.push(`Jev's nomination ${nomination.san} survived its own audit.`);
      break;
    }

    vetoed.push(nomination.san);
    notes.push(
      `Jev vetoed its own nomination ${nomination.san} (${triggered.map((entry) => entry.label).join(", ")}) and was asked again.`,
    );
    if (round === maxVetoes) {
      notes.push(`Veto limit reached after ${vetoed.length} rejected moves; the search's top move played instead.`);
      break;
    }
  }

  if (!chosen) {
    // Either Jev failed entirely or every nomination was vetoed: defer to the search.
    const fallbackPool = candidates.filter((candidate) => !vetoed.includes(candidate.san));
    chosen = (fallbackPool.length > 0 ? fallbackPool : candidates)[0] ?? null;
    if (chosen && !notes.some((note) => note.includes("search's top move played instead"))) {
      notes.push(`Nothing survived, so the search's top move ${chosen.san} played instead.`);
    }
  }
  if (!chosen) return { move: null, record: null };
  if (vetoed.length > 0) notes.push(`Moves Jev rejected: ${vetoed.join(", ")}.`);

  const ordered = [...candidates].sort(
    (a, b) => (probabilities.get(b.id) ?? 0) - (probabilities.get(a.id) ?? 0) || a.rank - b.rank,
  );
  const record = {
    mock,
    model,
    pipeline: "nominate-verify",
    pipelineName: "Jev nominates, Jev verifies",
    strategyId: strategy.id,
    strategyName: strategy.name,
    chosenSan: chosen.san,
    chosenFrom: chosen.from,
    chosenTo: chosen.to,
    chosenRank: ordered.findIndex((candidate) => candidate.id === chosen.id) + 1,
    searchRankOfChosen: chosen.rank,
    candidates: ordered.map((candidate) =>
      candidateRecord(candidate, {
        chosen,
        choiceProbabilities: Object.fromEntries(probabilities),
        strategy,
      }),
    ),
    weights: { choice: 1 },
    assessment,
    notes,
    audit: auditLog,
    vetoed,
    usage,
    requests,
    elapsedMs: Date.now() - startedAt,
    search: { depth: analysis.depth, nodes: analysis.nodes, bestCp: analysis.bestCp, bestSan: analysis.moves[0]?.san ?? null, elapsedMs: analysis.elapsedMs, forDisplayOnly: true },
    errors,
  };

  return { move: chosen.move, record };
}

// ---------------------------------------------------------------------------
// 4. search-only — the control opponent, no Jev at all
// ---------------------------------------------------------------------------

function searchOnly({ chess, strategy }) {
  const startedAt = Date.now();
  const analysis = analyzeRoot(chess, {
    depth: strategy.searchDepth,
    quiescence: strategy.quiescence,
    timeBudgetMs: strategy.timeBudgetMs,
  });
  const best = analysis.moves[0];
  const record = {
    mock: false,
    model: null,
    pipeline: "search-only",
    pipelineName: "Code only (baseline)",
    strategyId: strategy.id,
    strategyName: strategy.name,
    chosenSan: best.san,
    chosenFrom: best.from,
    chosenTo: best.to,
    chosenRank: 1,
    searchRankOfChosen: 1,
    candidates: analysis.moves.slice(0, 10).map((candidate) =>
      candidateRecord(candidate, { chosen: best, choiceProbabilities: {}, strategy }),
    ),
    weights: { search: 1 },
    assessment: null,
    notes: [`The search chose ${best.san} in ${Date.now() - startedAt} ms; Jev was not asked.`],
    audit: [],
    vetoed: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    requests: 0,
    elapsedMs: Date.now() - startedAt,
    search: { depth: analysis.depth, nodes: analysis.nodes, bestCp: analysis.bestCp, bestSan: best.san, elapsedMs: analysis.elapsedMs },
    errors: [],
  };
  return { move: best.move, record };
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function makeContext(turn) {
  return { side: { name: sideName(turn), color: turn }, opponent: { name: sideName(otherColor(turn)), color: otherColor(turn) } };
}

/** A short factual summary of a candidate, used as its Choice-option description. */
function summarizeCandidate(chess, candidate) {
  const bits = [];
  if (candidate.captured) bits.push(`captures the ${PIECE_NAMES[candidate.captured]} on ${candidate.to}`);
  if (candidate.promotion) bits.push(`promotes to a ${PIECE_NAMES[candidate.promotion]}`);
  if (candidate.flags?.includes?.("k")) bits.push("castles kingside");
  if (candidate.flags?.includes?.("q")) bits.push("castles queenside");
  if (!bits.length) bits.push("a quiet move");
  const applied = chess.move(candidate.move);
  const check = chess.isCheck();
  const mate = chess.isCheckmate();
  const replies = chess.moves().length;
  chess.undo();
  if (mate) bits.push("checkmate");
  else if (check) bits.push("gives check");
  bits.push(`leaves the opponent ${replies} legal ${replies === 1 ? "reply" : "replies"}`);
  return bits.join(", ");
}

/** Search score relative to the best move in the shortlist, 0..1. */
function searchUnit(cp, bestCp, mateIn) {
  if (mateIn !== null && mateIn !== undefined && mateIn > 0) return 1;
  if (Math.abs(cp) > MATE_THRESHOLD && cp < 0) return 0;
  return cpToUnit(cp - bestCp, 120);
}

/**
 * Weighted average of the available signals; weights need not sum to 1, and a signal
 * with no weight contributes nothing. If the caller zeroes every weight, the plain mean
 * of whatever signals exist is used, so a fully de-weighted strategy still ranks moves
 * deterministically instead of collapsing to a constant.
 */
function combine(values, weights) {
  let total = 0;
  let weightSum = 0;
  for (const [key, weight] of Object.entries(weights ?? {})) {
    const value = values[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (!weight) continue;
    total += value * weight;
    weightSum += weight;
  }
  if (weightSum > 0) return total / weightSum;

  const available = Object.values(values).filter((value) => typeof value === "number" && Number.isFinite(value));
  if (available.length === 0) return 0;
  return available.reduce((sum, value) => sum + value, 0) / available.length;
}

function readCompositeAnswers(response, { candidates, index, ctx }) {
  const answers = response?.answers ?? {};
  const dimsByCandidate = {};
  for (const candidate of candidates) dimsByCandidate[candidate.id] = {};
  for (const entry of index) {
    const definition = DIMENSIONS[entry.dim];
    const levelCount = definition ? definition.levels({ ...ctx, candidate: { id: entry.candidateId, san: "" } }).length : 4;
    const value = readScoreAnswer(answers[entry.id], levelCount);
    if (value !== null) dimsByCandidate[entry.candidateId][entry.dim] = value;
  }

  const validKeys = candidates.map((candidate) => `${candidate.id} ${candidate.san}`);
  const parsed = readChoiceAnswer(answers.best_move, validKeys);
  const probabilities = mapChoiceProbabilities(parsed.probabilities, candidates);
  const maxProbability = Math.max(0, ...probabilities.values());
  const choiceScores = { probabilities: Object.fromEntries(probabilities), invalidChoice: parsed.invalid };
  for (const candidate of candidates) {
    const probability = probabilities.get(candidate.id);
    if (probability === undefined) continue;
    choiceScores[candidate.id] = maxProbability > 0 ? clamp01(probability / maxProbability) : 0;
  }

  return {
    dimsByCandidate,
    choiceScores,
    assessment: readAssessment(answers),
    usage: response?.usage ?? null,
    model: response?.model ?? null,
    mock: response?.mock,
  };
}

/** Choice keys are "<candidate id> <san>"; map them back to candidate ids. */
function mapChoiceProbabilities(probabilities, candidates) {
  const result = new Map();
  for (const [key, value] of Object.entries(probabilities ?? {})) {
    const id = String(key).split(" ")[0];
    if (candidates.some((candidate) => candidate.id === id)) result.set(id, value);
  }
  return result;
}

function readAssessment(answers) {
  if (!answers) return null;
  const read = (answer, keys) => {
    const parsed = readChoiceAnswer(answer, keys);
    return { choice: parsed.choice, probabilities: parsed.probabilities, confidence: answer?.confidence ?? null };
  };
  const standing = read(answers.standing, ["white", "black", "equal"]);
  const phase = read(answers.phase, ["opening", "middlegame", "endgame"]);
  const plan = read(answers.plan, ["attack_king", "win_material", "improve_pieces", "trade_to_endgame", "defend_hold"]);
  if (!standing.choice && !phase.choice && !plan.choice) return null;
  return {
    standing,
    phase,
    plan,
    labels: {
      standing: { white: "White is better", black: "Black is better", equal: "Balanced" }[standing.choice] ?? null,
      phase: phase.choice,
      plan: {
        attack_king: "attack the king",
        win_material: "win material",
        improve_pieces: "improve the pieces",
        trade_to_endgame: "trade into an endgame",
        defend_hold: "defend and hold",
      }[plan.choice] ?? null,
    },
  };
}

const AUDIT_DEFINITIONS = [
  { id: "audit_hangs_material", label: "loses material", thresholdKey: "hangVeto" },
  { id: "audit_regret", label: "Jev would take it back", thresholdKey: "regretVeto" },
  { id: "audit_gives_away_advantage", label: "gives away an advantage", thresholdKey: "advantageVeto" },
];

function readAudit(answers, ctx) {
  if (!answers) return [];
  return AUDIT_DEFINITIONS.map((definition) => {
    const probability = readNoulAnswer(answers[definition.id]);
    const threshold = STRATEGY_TUNING[definition.thresholdKey] ?? 0.6;
    return {
      question: definition.id,
      label: definition.label,
      noul: probability,
      threshold,
      veto: probability !== null && probability >= threshold,
    };
  }).concat(
    (() => {
      const warning = readNoulAnswer(answers.audit_opponent_forcing);
      if (warning === null) return [];
      return [
        {
          question: "audit_opponent_forcing",
          label: "allows a forcing reply",
          noul: warning,
          threshold: STRATEGY_TUNING.forcingWarning,
          veto: false,
          warning: warning >= STRATEGY_TUNING.forcingWarning,
        },
      ];
    })(),
  );
}

function candidateRecord(candidate, { chosen, choiceProbabilities, strategy }) {
  const probability = choiceProbabilities?.[candidate.id];
  const dims = {};
  for (const [dim, value] of Object.entries(candidate.values ?? {})) {
    if (dim === "search" || dim === "choice") continue;
    dims[dim] = round3(value);
  }
  return {
    san: candidate.san,
    from: candidate.from,
    to: candidate.to,
    chosen: chosen ? candidate.id === chosen.id : false,
    searchCp: candidate.cp,
    searchRank: candidate.rank,
    searchScore: round3(candidate.values?.search ?? 0),
    choiceProb: probability === undefined ? null : round3(probability),
    dims,
    composite: round3(candidate.composite ?? 0),
    tags: deriveTags(candidate, { chosen, strategy }),
  };
}

/** Tags are code's reading of Jev's own scores plus hard facts — never invented prose. */
function deriveTags(candidate, { chosen, strategy }) {
  const tags = [];
  if (candidate.captured) {
    const gained = PIECE_VALUE[candidate.captured] ?? 0;
    const risked = PIECE_VALUE[candidate.piece] ?? 0;
    if (gained > risked) tags.push(`wins a ${PIECE_NAMES[candidate.captured]}`);
    else if (gained === risked) tags.push(`trades the ${PIECE_NAMES[candidate.piece]}`);
    else tags.push(`sacrifices for a ${PIECE_NAMES[candidate.captured]}`);
  }
  if (candidate.mateIn !== null && candidate.mateIn !== undefined && candidate.mateIn > 0) tags.push(`mate in ${candidate.mateIn}`);
  else if (candidate.flags?.includes?.("k") || candidate.flags?.includes?.("q")) tags.push("castles");
  else if (candidate.promotion) tags.push("promotes");
  const dims = candidate.values ?? {};
  if (dims.safety !== undefined && dims.safety >= 0.8) tags.push("safe");
  if (dims.safety !== undefined && dims.safety <= 0.3) tags.push("risky");
  if (dims.kingPressure !== undefined && dims.kingPressure >= 0.75) tags.push("attacks the king");
  if (dims.activity !== undefined && dims.activity >= 0.75) tags.push("activates pieces");
  if (dims.pawnStructure !== undefined && dims.pawnStructure >= 0.75) tags.push("improves pawns");
  if (dims.endgameTechnique !== undefined && dims.endgameTechnique >= 0.75) tags.push("endgame progress");
  if (dims.quality !== undefined && dims.quality >= 0.75) tags.push("Jev rates it highly");
  if (chosen && candidate.id === chosen.id && (candidate.values?.choice ?? 0) > 0.9) tags.push("Jev's own favourite");
  return tags.slice(0, 4);
}

function addUsage(a, b) {
  return {
    input_tokens: (a?.input_tokens ?? 0) + (b?.input_tokens ?? 0),
    output_tokens: (a?.output_tokens ?? 0) + (b?.output_tokens ?? 0),
  };
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export { combine, searchUnit, summarizeCandidate };
