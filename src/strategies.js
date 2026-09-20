/**
 * Strategies: named presets that decide how a Jev player thinks, plus the slider
 * schema the UI uses to tune them.
 *
 * A strategy has three independent parts:
 *   1. `pipeline` — how much of the decision is code and how much is Jev (see PIPELINES).
 *   2. `candidateLimit` / `searchDepth` — how wide and deep the code half looks.
 *   3. `weights` — how the available signals are combined into a final score. These are
 *      the numbers the UI sliders move, and the only tuning a player normally needs.
 *
 * `dim` weights only apply when the pipeline asks Jev that dimension, so a preset that
 * does not list `pawnStructure` in `dims` simply has no pawn-structure signal.
 */

/** Every weight the composite step understands. */
export const WEIGHT_KEYS = [
  "search",
  "choice",
  "quality",
  "safety",
  "activity",
  "kingPressure",
  "kingSafety",
  "pawnStructure",
  "endgameTechnique",
];

/**
 * Slider schema for the UI. `key` is a weight key; `default` is only the starting
 * position for the control (each preset supplies its own value).
 */
export const SLIDERS = [
  {
    key: "search",
    label: "Code search",
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.3,
    help: "Weight of the server's shallow search (material and tactics). Higher means safer, blunder-proof play and less say for Jev.",
  },
  {
    key: "choice",
    label: "Jev's own pick",
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.15,
    help: "Weight of the move Jev itself nominated when asked to choose among the candidates.",
  },
  {
    key: "quality",
    label: "Move quality",
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.2,
    help: "Weight of Jev's overall judgement of each candidate move.",
  },
  {
    key: "safety",
    label: "Material safety",
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.15,
    help: "Weight of Jev's judgement that the move cannot be refuted immediately.",
  },
  {
    key: "activity",
    label: "Piece activity",
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.1,
    help: "Weight of Jev's judgement that the move develops, centralises or coordinates pieces.",
  },
  {
    key: "kingPressure",
    label: "Pressure on enemy king",
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.05,
    help: "Weight of Jev's judgement that the move creates danger around the opponent's king.",
  },
  {
    key: "kingSafety",
    label: "Own king safety",
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.05,
    help: "Weight of Jev's judgement that the move keeps the mover's own king protected.",
  },
  {
    key: "pawnStructure",
    label: "Pawn structure",
    min: 0,
    max: 1,
    step: 0.05,
    default: 0,
    help: "Weight of Jev's judgement about pawn weaknesses and passed pawns.",
  },
  {
    key: "endgameTechnique",
    label: "Endgame technique",
    min: 0,
    max: 1,
    step: 0.05,
    default: 0,
    help: "Weight of Jev's judgement about converting or holding endgames.",
  },
];

/** The pipelines: the three ways a Jev player can decide, plus a code-only baseline. */
export const PIPELINES = {
  "shortlist-composite": {
    id: "shortlist-composite",
    name: "Shortlist + composite scoring",
    description:
      "Code ranks every legal move with a shallow search and keeps a shortlist with no outright blunder. " +
      "Jev then scores every candidate on several dimensions and nominates one; code combines the search score " +
      "and Jev's judgements with the strategy's weights. One Jev request per move.",
    requestsPerMove: 1,
    usesSearch: true,
  },
  "pure-choice": {
    id: "pure-choice",
    name: "Pure Jev choice",
    description:
      "Jev is shown every legal move and asked which is best; its top pick plays. No search, no filtering: " +
      "the most literal reading of 'Jev plays chess', and the weakest. Illegal or unknown answers fall back " +
      "to Jev's next-best legal option, and that fallback is reported in the move record.",
    requestsPerMove: 1,
    usesSearch: false,
  },
  "nominate-verify": {
    id: "nominate-verify",
    name: "Jev nominates, Jev verifies",
    description:
      "Jev nominates a move from all legal moves, then audits its own nomination with yes/no questions " +
      "(does it hang material, would Jev take it back, does it give away an advantage). A vetoed move is " +
      "excluded and Jev is asked again, up to the strategy's veto limit. Two or more Jev requests per move.",
    requestsPerMove: 2,
    usesSearch: false,
  },
  "search-only": {
    id: "search-only",
    name: "Code only (baseline)",
    description:
      "The shallow search decides and Jev is never asked. A control opponent for measuring how much Jev " +
      "actually adds, and a blunder-free sparring partner.",
    requestsPerMove: 0,
    usesSearch: true,
  },
};

/**
 * Presets. `balanced` is the one labelled "best": it is the only preset that uses the
 * full shortlist pipeline with every dimension and a meaningful search weight, and it
 * is the default for both seats.
 */
export const PRESETS = [
  {
    id: "balanced",
    name: "Balanced (best)",
    description:
      "The default. A blunder-free shortlist from a 3-ply search, then Jev scores quality, safety, activity, " +
      "king pressure and its own king safety, and code blends them with the search score.",
    pipeline: "shortlist-composite",
    best: true,
    candidateLimit: 12,
    searchDepth: 3,
    quiescence: 3,
    temperature: 0.1,
    dims: ["quality", "safety", "activity", "kingPressure", "kingSafety"],
    weights: {
      search: 0.3,
      choice: 0.15,
      quality: 0.2,
      safety: 0.15,
      activity: 0.1,
      kingPressure: 0.05,
      kingSafety: 0.05,
    },
  },
  {
    id: "strategist",
    name: "Strategist (Gemini plan + Jev)",
    description:
      "A reasoning model chooses the plan from a fixed vocabulary and shifts the scoring weights; the code " +
      "search keeps it legal and tactical; Jev judges the candidates. Costs one Gemini call every few plies " +
      "on top of Jev's per-move call, and a plan that fails validation is ignored rather than obeyed.",
    pipeline: "shortlist-composite",
    candidateLimit: 12,
    searchDepth: 3,
    quiescence: 2,
    temperature: 0.1,
    dims: ["quality", "safety", "activity", "kingPressure", "kingSafety"],
    weights: { search: 0.3, choice: 0.15, quality: 0.2, safety: 0.15, activity: 0.1, kingPressure: 0.05, kingSafety: 0.05 },
    llmPlan: true,
  },
  {
    id: "strategist-routing",
    name: "Strategist (routing only)",
    description:
      "The same Gemini planning step as the Strategist, minus the weight shift: the plan may choose which of " +
      "Jev's questions to ask, but the preset's weights stay exactly as they are. Built as the control for the " +
      "weight shift, which carries the largest measured cost so far (-88 cp per re-judged deviation, against " +
      "-32 cp for the same judge with no plan) — though the samples are too small to separate that from noise.",
    pipeline: "shortlist-composite",
    candidateLimit: 12,
    searchDepth: 3,
    quiescence: 2,
    temperature: 0.1,
    dims: ["quality", "safety", "activity", "kingPressure", "kingSafety"],
    weights: { search: 0.3, choice: 0.15, quality: 0.2, safety: 0.15, activity: 0.1, kingPressure: 0.05, kingSafety: 0.05 },
    llmPlan: true,
    routingOnly: true,
  },
  {
    id: "tactical",
    name: "Tactical (hard to beat)",
    description:
      "A deeper search (4 ply), a shorter shortlist and most of the weight on the search score, with Jev asked " +
      "only about quality and material safety. The safest opponent; Jev's role is small on purpose.",
    pipeline: "shortlist-composite",
    candidateLimit: 8,
    searchDepth: 4,
    quiescence: 4,
    temperature: 0.05,
    dims: ["quality", "safety"],
    weights: { search: 0.6, choice: 0.05, quality: 0.2, safety: 0.15 },
  },
  {
    id: "positional",
    name: "Positional",
    description: "Jev judges quality, activity, pawn structure and its own king safety; the search only breaks ties.",
    pipeline: "shortlist-composite",
    candidateLimit: 12,
    searchDepth: 3,
    quiescence: 3,
    temperature: 0.12,
    dims: ["quality", "activity", "pawnStructure", "kingSafety"],
    weights: { search: 0.2, choice: 0.15, quality: 0.2, activity: 0.2, pawnStructure: 0.15, kingSafety: 0.1 },
  },
  {
    id: "attacking",
    name: "Attacking",
    description: "Jev is asked how much danger each move creates around the enemy king, and that dominates the score.",
    pipeline: "shortlist-composite",
    candidateLimit: 14,
    searchDepth: 3,
    quiescence: 3,
    temperature: 0.2,
    dims: ["quality", "kingPressure", "activity", "safety"],
    weights: { search: 0.15, choice: 0.15, quality: 0.15, kingPressure: 0.3, activity: 0.2, safety: 0.05 },
  },
  {
    id: "endgame",
    name: "Endgame technician",
    description: "Jev judges technical endgame progress along with quality, king safety and safety.",
    pipeline: "shortlist-composite",
    candidateLimit: 12,
    searchDepth: 3,
    quiescence: 3,
    temperature: 0.1,
    dims: ["quality", "endgameTechnique", "kingSafety", "safety"],
    weights: { search: 0.25, choice: 0.1, quality: 0.2, endgameTechnique: 0.3, kingSafety: 0.1, safety: 0.05 },
  },
  {
    id: "pure-jev",
    name: "Pure Jev (no code filter)",
    description:
      "Every legal move goes to Jev as one choice question and the highest probability plays. No search, no " +
      "blunder filter. Expect hung pieces and occasional illegal move names — both are reported in the panel.",
    pipeline: "pure-choice",
    candidateLimit: null,
    searchDepth: 0,
    temperature: 0,
    dims: [],
    weights: { choice: 1 },
  },
  {
    id: "jev-verify",
    name: "Jev nominates, Jev verifies",
    description:
      "Jev picks from all legal moves, then audits its own choice and must try again if it concludes the move " +
      "hangs material or that it would want it back. Two or more requests per move.",
    pipeline: "nominate-verify",
    candidateLimit: null,
    searchDepth: 0,
    temperature: 0,
    dims: [],
    maxVetoes: 3,
    weights: { choice: 1 },
  },
  {
    id: "code-only",
    name: "Code only (baseline, no Jev)",
    description: "The shallow search plays by itself. Useful as a control for 'how much does Jev add?'.",
    pipeline: "search-only",
    candidateLimit: 1,
    searchDepth: 3,
    quiescence: 3,
    temperature: 0,
    dims: [],
    weights: { search: 1 },
  },
];

export const DEFAULT_STRATEGY_ID = "balanced";

/**
 * How long the code half may spend on one move, in milliseconds. Measured with
 * tests/search-bench.mjs: a full-width 3-ply search in a busy middlegame does not
 * finish in a sensible time on top of this rules engine, so the search deepens
 * iteratively and stops at this budget, returning the deepest complete iteration.
 * Jev's request is unaffected — this bounds only the code half of a move.
 */
export const DEFAULT_TIME_BUDGET_MS = 1400;

export function getPreset(id) {
  return PRESETS.find((preset) => preset.id === id) ?? null;
}

export function isWeightKey(key) {
  return WEIGHT_KEYS.includes(key);
}

/**
 * Turn a `{ strategyId, weights }` request into a complete, validated strategy.
 * Unknown weight keys are dropped; out-of-range numbers are clamped; a missing or
 * unknown preset falls back to the default so a bad request can never stop a game.
 */
export function resolveStrategy({ strategyId, weights, timeBudgetMs } = {}) {
  const preset = getPreset(strategyId) ?? getPreset(DEFAULT_STRATEGY_ID);
  const merged = { ...preset.weights };
  const appliedOverrides = {};
  for (const [key, value] of Object.entries(weights ?? {})) {
    if (!isWeightKey(key)) continue;
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) continue;
    merged[key] = Math.min(1, Math.max(0, numeric));
    appliedOverrides[key] = merged[key];
  }

  // The search budget can be overridden per player (clamped to something sane), which is
  // what lets a soak test play whole games quickly without touching the defaults.
  const requestedBudget = Number(timeBudgetMs);
  const resolvedBudget = Number.isFinite(requestedBudget)
    ? Math.min(10_000, Math.max(50, Math.round(requestedBudget)))
    : preset.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;

  // Keep only the weights this strategy can actually use, so the UI's "weights in
  // force" list matches what the composite step really did.
  const activeKeys = WEIGHT_KEYS.filter((key) => {
    if (key === "search") return preset.pipeline === "shortlist-composite" || preset.pipeline === "search-only";
    if (key === "choice") return preset.pipeline !== "search-only";
    return (preset.dims ?? []).includes(key);
  });
  const active = {};
  for (const key of activeKeys) if (merged[key] !== undefined) active[key] = merged[key];
  const total = Object.values(active).reduce((sum, value) => sum + value, 0);

  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    pipeline: preset.pipeline,
    best: Boolean(preset.best),
    candidateLimit: preset.candidateLimit,
    searchDepth: preset.searchDepth ?? 0,
    quiescence: preset.quiescence ?? 2,
    timeBudgetMs: resolvedBudget,
    temperature: preset.temperature ?? 0.1,
    maxVetoes: preset.maxVetoes ?? 3,
    dims: preset.dims ?? [],
    // Experiment switches (see src/jev/state.js). Off by default; a preset may turn
    // them on so the experiment harness can measure what they change.
    includeBoards: preset.includeBoards !== false,
    exposeCaptureEvidence: Boolean(preset.exposeCaptureEvidence),
    includeSearchHints: Boolean(preset.includeSearchHints),
    // A strategy that asks the strategist for a plan before Jev judges the candidates.
    llmPlan: Boolean(preset.llmPlan),
    // A planning seat that lets the plan route Jev's questions but never shift the weights.
    // The full Strategist's weight shift is what measured as costing material (-88 cp per
    // deviation vs -34 cp for the same judge with no plan), so this is the control for it.
    routingOnly: Boolean(preset.routingOnly),
    weights: active,
    presetWeights: preset.weights,
    weightsNormalized: total > 0 ? Object.fromEntries(Object.entries(active).map(([k, v]) => [k, v / total])) : {},
    overrides: appliedOverrides,
  };
}

/** Payload for `GET /api/strategies`. */
export function strategiesPayload() {
  return {
    presets: PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      pipeline: preset.pipeline,
      pipelineName: PIPELINES[preset.pipeline]?.name ?? preset.pipeline,
      best: Boolean(preset.best),
      candidateLimit: preset.candidateLimit,
      searchDepth: preset.searchDepth ?? 0,
      temperature: preset.temperature ?? 0,
      dims: preset.dims ?? [],
      weights: preset.weights,
    })),
    sliders: SLIDERS,
    pipelines: Object.values(PIPELINES),
    defaultStrategyId: DEFAULT_STRATEGY_ID,
  };
}
