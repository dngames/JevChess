/**
 * The strategist: deciding *when* to ask for a plan, and turning the answer into a strategy.
 *
 * Split out of `Game` deliberately. The game loop should not know how a plan is obtained, and
 * this is the piece worth unit-testing: the review triggers are a policy decision (too eager and
 * every move costs a reasoning call; too lazy and the plan is stale), and they are the main lever
 * on cost.
 *
 * Cost control, concretely: a review happens at a trigger, not on a timer. Routine checks ask for
 * `low` thinking; a crisis (the assessment swung, or the opponent broke the plan) asks for `high`.
 * With `reviewAfterPlies` around 5, a 40-move game makes ~8 calls.
 */

import { applyPlan, validatePlan } from "./plan.js";
import { PLAN_JSON_SCHEMA, PLAN_SYSTEM_PROMPT, PROMPT_VERSION, buildPlanInput } from "./prompts.js";

/**
 * A swing this large since the plan was made is worth re-examining — and it takes this much
 * because the evaluation is a shallow, noisy number: consecutive depth-2 evaluations of quiet
 * positions differ by 50-100cp routinely, so a tighter threshold fires on noise (measured: 150cp
 * fired almost every move).
 */
export const EVAL_SWING_CP = 250;
/** And it has to have had time to mean something: no swing checks in the first couple of plies. */
export const EVAL_SWING_MIN_PLIES = 3;
/** Triggers that justify the expensive thinking level rather than the cheap one. */
export const CRISIS_REASONS = new Set(["eval-swing", "plan-broken", "no-plan"]);

const PIECE_VALUE = { n: 320, b: 330, r: 500, q: 900 };

/**
 * The phase, computed by code rather than asked of a model.
 *
 * This started as Jev's `phase` answer, and that was a mistake: a judgement model answers the
 * phase question per position, not per game, so its answer flips around the same middlegame and
 * every flip triggered a plan review — 83 reviews in 89 plies in the test that caught it. The
 * phase is mechanical (how much non-pawn material is left, how far into the game we are), so
 * code computes it and Jev's read is kept for display only.
 */
export function phaseForPosition(chess) {
  let nonPawn = 0;
  let pieces = 0;
  for (const cell of chess.board().flat()) {
    if (!cell) continue;
    pieces += 1;
    if (cell.type !== "p" && cell.type !== "k") nonPawn += PIECE_VALUE[cell.type] ?? 0;
  }
  if (nonPawn <= 1300) return "endgame";
  const moveNumber = chess.moveNumber?.() ?? 1;
  if (moveNumber <= 10 && nonPawn >= 5600 && pieces >= 28) return "opening";
  return "middlegame";
}

/**
 * Should the strategist be asked again?
 *
 * @param {object} state
 * @param {object|null} state.plan            the plan in force
 * @param {number} state.pliesSinceReview
 * @param {string|null} state.phase           Jev's current read of the phase
 * @param {string|null} state.planPhase       the phase the current plan was made in
 * @param {number|null} state.evalCp          the code search's score now (white-positive)
 * @param {number|null} state.planEvalCp      the score when the plan was made
 * @param {boolean} [state.targetTouched]     did the opponent's last move land on a target square
 * @param {boolean} [state.forced]            force a review (tests, or "ask again" from the UI)
 * @returns {{review: boolean, reason: string, thinkingLevel: "low"|"high"}}
 */
export function shouldReview({
  plan = null,
  pliesSinceReview = 0,
  phase = null,
  planPhase = null,
  evalCp = null,
  planEvalCp = null,
  targetTouched = false,
  forced = false,
} = {}) {
  if (forced) return { review: true, reason: "forced", thinkingLevel: "high" };
  if (!plan) return { review: true, reason: "no-plan", thinkingLevel: "medium" };

  if (typeof plan.reviewAfterPlies === "number" && pliesSinceReview >= plan.reviewAfterPlies) {
    return { review: true, reason: "plan-expired", thinkingLevel: "low" };
  }
  if (phase && planPhase && phase !== planPhase) {
    return { review: true, reason: "phase-change", thinkingLevel: "medium" };
  }
  if (targetTouched) return { review: true, reason: "plan-broken", thinkingLevel: "high" };
  if (
    pliesSinceReview >= EVAL_SWING_MIN_PLIES &&
    typeof evalCp === "number" &&
    typeof planEvalCp === "number" &&
    Math.abs(evalCp - planEvalCp) >= EVAL_SWING_CP
  ) {
    return { review: true, reason: "eval-swing", thinkingLevel: "high" };
  }
  return { review: false, reason: "plan-still-valid", thinkingLevel: "low" };
}

/**
 * Ask the strategist, validate the answer, and apply it — or explain why it was not applied.
 *
 * Never throws and never returns a broken strategy: on any failure the caller keeps the preset,
 * which is the same discipline the Jev layer follows.
 *
 * @returns {Promise<object>} a record suitable for the move record and the UI
 */
export async function reviewPlan({
  llmClient,
  chess,
  baseStrategy,
  currentPlan = null,
  pliesSinceReview = 0,
  evalCp = null,
  evalLabel = null,
  phase = null,
  lastMoves = [],
  opponentLastMove = null,
  jevRead = null,
  thinkingLevel = "medium",
  reason = "unspecified",
  signal = null,
} = {}) {
  const startedAt = Date.now();
  const record = {
    enabled: true,
    promptVersion: PROMPT_VERSION,
    reason,
    thinkingLevel,
    ok: false,
    plan: null,
    applied: null,
    raw: null,
    problems: [],
    warnings: [],
    notes: [],
    usage: null,
    costUsd: null,
    model: llmClient?.model ?? null,
    api: llmClient?.api ?? null,
    mock: Boolean(llmClient?.mock),
    elapsedMs: 0,
    error: null,
    strategy: baseStrategy,
  };

  if (!llmClient) {
    record.error = "no strategist is configured";
    record.elapsedMs = Date.now() - startedAt;
    return record;
  }

  const input = buildPlanInput({
    chess,
    evalCp,
    evalLabel,
    phase,
    plan: currentPlan,
    pliesSinceReview,
    lastMoves,
    opponentLastMove,
    jevRead,
  });

  let result;
  try {
    result = await llmClient.generateJson({
      input,
      systemInstruction: PLAN_SYSTEM_PROMPT,
      schema: PLAN_JSON_SCHEMA,
      thinkingLevel,
      signal,
    });
  } catch (error) {
    record.error = error?.message ?? String(error);
    record.elapsedMs = Date.now() - startedAt;
    return record;
  }

  record.elapsedMs = Date.now() - startedAt;
  record.usage = result.usage ?? null;
  record.costUsd = result.costUsd ?? null;
  record.attempts = result.attempts ?? 0;
  if (Array.isArray(result.notes)) record.notes.push(...result.notes);

  if (!result.ok) {
    record.error = result.error ?? "the strategist failed";
    record.code = result.code ?? null;
    return record;
  }

  record.raw = result.json;
  const { plan, problems, warnings } = validatePlan(result.json, { phase });
  record.problems = problems;
  record.warnings = warnings;

  if (!plan) {
    record.error = `the strategist's answer was unusable: ${problems.join("; ")}`;
    return record;
  }

  const { strategy, applied } = applyPlan(baseStrategy, plan);
  record.ok = true;
  record.plan = plan;
  record.applied = applied;
  record.strategy = strategy;
  if (applied.notes?.length) record.notes.push(...applied.notes);
  return record;
}

/** One line summarising a plan record, for logs and the UI. */
export function describeReview(record) {
  if (!record) return "no review";
  if (!record.ok) return `no plan (${record.error ?? record.reason})`;
  const target = record.plan?.targets?.length ? ` → ${record.plan.targets.join(", ")}` : "";
  const cost = typeof record.costUsd === "number" ? ` $${record.costUsd.toFixed(4)}` : "";
  return `${record.plan.plan}${target} (${record.reason}, ${record.elapsedMs} ms${cost})`;
}
