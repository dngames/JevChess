/**
 * The plan: everything a reasoning model is allowed to decide, and nothing else.
 *
 * This is the strategy layer's equivalent of `src/jev/questions.js` — one reviewable file that
 * contains the vocabulary a model may use and the bounds it is held to. The model never names
 * a move; it chooses a plan from a fixed list, names a target square, shifts the composite
 * weights within a clamp, and routes which of Jev's dimensions to ask about. Code validates
 * every field, drops what it cannot use, and reports what it dropped.
 *
 * Why a fixed vocabulary rather than free text: the plan has to be checkable. `plan` selects
 * a default set of dimensions, and `target` becomes a measurable feature ("is pressure on c5
 * increasing?"), so the plan's own progress can be audited by code instead of being taken on
 * trust. A prose plan cannot be falsified, and this project has already been bitten once by
 * letting the same system produce and grade its own judgement.
 *
 * Pure module: no I/O, no network, no model. Everything here is unit-testable.
 */

import { DIMENSIONS } from "../jev/questions.js";

/** The plans a strategist may choose. Each leans on dimensions that suit it. */
export const PLAN_KINDS = {
  develop: {
    label: "Develop and centralise",
    help: "Finish development, fight for the centre, keep options open.",
    dims: ["quality", "activity"],
    phases: ["opening", "middlegame"],
  },
  attack_king: {
    label: "Attack the king",
    help: "Aim pieces and pawns at the enemy king and open lines towards it.",
    dims: ["kingPressure", "quality", "safety"],
    phases: ["middlegame"],
  },
  minority_attack: {
    label: "Minority attack",
    help: "Push pawns on the side where you are weaker in numbers to damage the enemy pawns.",
    dims: ["pawnStructure", "activity", "quality"],
    phases: ["middlegame"],
  },
  pawn_break: {
    label: "Pawn break",
    help: "Prepare and execute a central pawn break to open the position.",
    dims: ["pawnStructure", "safety", "quality"],
    phases: ["opening", "middlegame"],
  },
  improve_pieces: {
    label: "Improve the worst piece",
    help: "No forcing continuation: put the least useful piece on a better square.",
    dims: ["activity", "quality"],
    phases: ["opening", "middlegame", "endgame"],
  },
  seize_file: {
    label: "Seize the open file",
    help: "Contest and occupy a file or the only open line.",
    dims: ["activity", "quality"],
    phases: ["middlegame", "endgame"],
  },
  restrain: {
    label: "Restrain and blockade",
    help: "Prevent the opponent's freeing break; blockade their pawns.",
    dims: ["pawnStructure", "kingSafety", "quality"],
    phases: ["middlegame", "endgame"],
  },
  simplify: {
    label: "Simplify",
    help: "Trade pieces while keeping the better structure or the safer king.",
    dims: ["endgameTechnique", "safety"],
    phases: ["middlegame", "endgame"],
  },
  trade_to_endgame: {
    label: "Head for a good endgame",
    help: "Steer into an endgame that favours you.",
    dims: ["endgameTechnique", "safety", "quality"],
    phases: ["middlegame", "endgame"],
  },
  promote_passer: {
    label: "Push the passed pawn",
    help: "Advance and support a passed pawn; use the king actively.",
    dims: ["endgameTechnique", "pawnStructure", "kingSafety"],
    phases: ["endgame"],
  },
  activate_king: {
    label: "Activate the king",
    help: "Endgame king activity: march the king towards the action.",
    dims: ["endgameTechnique", "kingSafety"],
    phases: ["endgame"],
  },
  defend_hold: {
    label: "Defend and hold",
    help: "Worse position: consolidate, cover weaknesses, avoid weakening moves.",
    dims: ["kingSafety", "safety", "quality"],
    phases: ["opening", "middlegame", "endgame"],
  },
};

export const PLAN_IDS = Object.keys(PLAN_KINDS);
export const RISK_LEVELS = ["hold", "balanced", "complicate"];
export const DIMENSION_IDS = Object.keys(DIMENSIONS);

/** Bounds. A plan that breaks these is clamped, not obeyed. */
export const MIN_REVIEW_PLIES = 1;
export const MAX_REVIEW_PLIES = 16;
export const DEFAULT_REVIEW_PLIES = 5;
export const MAX_WEIGHT_DELTA = 0.25;
export const MAX_COMMENTARY = 320;
export const MAX_TARGETS = 3;

const SQUARE = /^[a-h][1-8]$/;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * Validate and normalise whatever the model returned.
 *
 * @param {unknown} raw                the parsed JSON from the strategist
 * @param {{phase?: string|null}} [options]  Jev's read of the phase, used only for warnings
 * @returns {{plan: object|null, problems: string[], warnings: string[]}}
 *   `plan` is null when the answer is unusable; the caller then keeps the preset strategy.
 */
export function validatePlan(raw, { phase = null } = {}) {
  const problems = [];
  const warnings = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { plan: null, problems: ["the strategist did not return a JSON object"], warnings };
  }

  const kind = typeof raw.plan === "string" ? raw.plan.trim().toLowerCase().replace(/[\s-]+/g, "_") : null;
  if (!kind || !PLAN_KINDS[kind]) {
    return {
      plan: null,
      problems: [`"${String(raw.plan ?? "").slice(0, 40)}" is not one of the ${PLAN_IDS.length} known plans`],
      warnings,
    };
  }
  const definition = PLAN_KINDS[kind];

  // Targets: real squares only, at most a few.
  const rawTargets = Array.isArray(raw.targets) ? raw.targets : raw.target ? [raw.target] : [];
  const targets = [];
  for (const candidate of rawTargets) {
    const square = typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
    if (!SQUARE.test(square)) {
      problems.push(`dropped target "${String(candidate).slice(0, 12)}": not a square`);
      continue;
    }
    if (!targets.includes(square)) targets.push(square);
    if (targets.length >= MAX_TARGETS) break;
  }

  const risk = RISK_LEVELS.includes(raw.risk) ? raw.risk : "balanced";
  if (raw.risk !== undefined && !RISK_LEVELS.includes(raw.risk)) {
    problems.push(`ignored risk "${String(raw.risk).slice(0, 20)}": not one of ${RISK_LEVELS.join("/")}`);
  }

  const requested = Number(raw.review_after_plies);
  const reviewAfterPlies = Number.isFinite(requested)
    ? Math.round(clamp(requested, MIN_REVIEW_PLIES, MAX_REVIEW_PLIES))
    : DEFAULT_REVIEW_PLIES;

  // Weight deltas: known keys only, clamped. The model may nudge the mix, never set it.
  const weightDeltas = {};
  if (raw.weight_deltas && typeof raw.weight_deltas === "object" && !Array.isArray(raw.weight_deltas)) {
    for (const [key, value] of Object.entries(raw.weight_deltas)) {
      const numeric = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(numeric)) {
        problems.push(`ignored weight delta for "${key}": not a number`);
        continue;
      }
      const clamped = clamp(numeric, -MAX_WEIGHT_DELTA, MAX_WEIGHT_DELTA);
      if (clamped !== numeric) warnings.push(`clamped ${key} delta from ${numeric} to ${clamped}`);
      if (clamped !== 0) weightDeltas[key] = Math.round(clamped * 1000) / 1000;
    }
  }

  // Question routing: the model may focus Jev, but only on dimensions the strategy can weigh.
  const askJev = [];
  if (Array.isArray(raw.ask_jev)) {
    for (const candidate of raw.ask_jev) {
      const dimension = typeof candidate === "string" ? candidate.trim() : "";
      if (!DIMENSION_IDS.includes(dimension)) {
        problems.push(`ignored requested dimension "${String(candidate).slice(0, 24)}": unknown`);
        continue;
      }
      if (!askJev.includes(dimension)) askJev.push(dimension);
    }
  } else if (raw.ask_jev !== undefined) {
    problems.push("ignored ask_jev: not an array");
  }

  let opponentPlan = null;
  if (typeof raw.opponent_plan === "string") {
    const guess = raw.opponent_plan.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (PLAN_KINDS[guess]) opponentPlan = guess;
    else warnings.push(`ignored opponent_plan "${raw.opponent_plan.slice(0, 30)}": not a known plan`);
  }

  let commentary = typeof raw.commentary === "string" ? raw.commentary.trim().replace(/\s+/g, " ") : "";
  if (commentary.length > MAX_COMMENTARY) {
    commentary = `${commentary.slice(0, MAX_COMMENTARY - 1)}…`;
    warnings.push("commentary was truncated for display");
  }

  if (phase && Array.isArray(definition.phases) && !definition.phases.includes(phase)) {
    warnings.push(`${kind} is unusual in the ${phase}; accepted anyway`);
  }

  return {
    plan: {
      plan: kind,
      label: definition.label,
      targets,
      risk,
      reviewAfterPlies,
      weightDeltas,
      askJev,
      opponentPlan,
      commentary,
    },
    problems,
    warnings,
  };
}

/** Stable identity of a plan, for deciding whether a cached plan is still the same plan. */
export function planSignature(plan) {
  if (!plan) return "none";
  return [
    plan.plan,
    plan.targets.join("+"),
    plan.risk,
    Object.entries(plan.weightDeltas)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}:${value}`)
      .join(","),
    plan.askJev.join("+"),
  ].join("|");
}

/**
 * Apply a plan to a resolved strategy, returning a new strategy.
 *
 * Rules, all deliberate:
 *  - weight deltas are added to a *copy* and clamped to 0..1, so a plan can nudge the mix but
 *    never invert the strategy's character;
 *  - routing is intersected with the dimensions this strategy actually weighs. Asking Jev
 *    about a dimension nothing weights would cost tokens and change nothing — a silent
 *    no-op is worse than a dropped request, so it is dropped and reported;
 *  - the pipeline, candidate limit and search budget are untouched. A strategist chooses
 *    emphasis, not machinery.
 *
 * @returns {{strategy: object, applied: {weights: object, dims: string[], dropped: string[], notes: string[]}}}
 */
export function applyPlan(strategy, plan) {
  const notes = [];
  if (!plan) return { strategy, applied: { weights: {}, dims: strategy.dims ?? [], dropped: [], notes } };

  const weighable = Object.keys(strategy.weights ?? {}).filter((key) => DIMENSION_IDS.includes(key));
  const weights = { ...strategy.weights };
  const appliedWeights = {};
  for (const [key, delta] of Object.entries(plan.weightDeltas ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(weights, key)) {
      notes.push(`plan wanted to shift ${key}, which this strategy does not weigh; ignored`);
      continue;
    }
    const before = weights[key];
    weights[key] = Math.round(clamp(before + delta, 0, 1) * 1000) / 1000;
    if (weights[key] !== before) appliedWeights[key] = Math.round((weights[key] - before) * 1000) / 1000;
  }

  const requested = plan.askJev ?? [];
  const dropped = requested.filter((dimension) => !weighable.includes(dimension));
  const used = requested.filter((dimension) => weighable.includes(dimension));
  // No routing from the model means "use what the plan is naturally about", intersected with
  // what this strategy can weigh.
  const defaults = (PLAN_KINDS[plan.plan]?.dims ?? []).filter((dimension) => weighable.includes(dimension));
  const dims = used.length > 0 ? used : defaults.length > 0 ? defaults : strategy.dims ?? [];

  const total = Object.values(weights).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const weightsNormalized =
    total > 0 ? Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, value / total])) : {};

  const applied = {
    weights: appliedWeights,
    dims,
    dropped,
    notes,
  };

  const shifted = Object.entries(appliedWeights)
    .map(([key, delta]) => `${key} ${delta > 0 ? "+" : ""}${delta}`)
    .join(", ");
  notes.unshift(
    `Plan: ${plan.label}${plan.targets.length ? ` (target ${plan.targets.join(", ")})` : ""}, risk ${plan.risk}.` +
      (shifted ? ` Weights shifted: ${shifted}.` : "") +
      (dims.length ? ` Jev asked about ${dims.join(", ")}.` : ""),
  );
  if (dropped.length > 0) notes.push(`Routing dropped (nothing weights them): ${dropped.join(", ")}.`);

  return {
    strategy: { ...strategy, weights, weightsNormalized, dims, plan },
    applied,
  };
}

/** One line for logs and the UI header. */
export function describePlan(plan) {
  if (!plan) return "no plan";
  const parts = [plan.label];
  if (plan.targets.length) parts.push(`target ${plan.targets.join(", ")}`);
  parts.push(`risk ${plan.risk}`);
  parts.push(`review in ${plan.reviewAfterPlies} plies`);
  return parts.join(" · ");
}
