/**
 * The strategist's prompt and the JSON schema its answer must satisfy.
 *
 * One reviewable file, like `src/jev/questions.js`, and for the same reason: this is the text
 * that decides how well the layer works, so it should be easy to find, easy to diff and easy
 * to iterate on. `PROMPT_VERSION` is stamped into every move record, so a measurement run can
 * always be attributed to the exact wording that produced it.
 *
 * Two deliberate asymmetries with the Jev layer:
 *
 *  - The strategist **is** shown the code's evaluation, the material count and Jev's last read.
 *    Anchoring a planner on the engine's assessment is the point; anchoring a judge on it would
 *    destroy the information its judgement carries (which is why `includeSearchHints` stays off
 *    for Jev).
 *  - The strategist is **not** shown the list of legal moves. It never chooses one, and handing
 *    it a candidate list would only invite it to try.
 */

import { boardText, pieceList } from "../jev/state.js";
import { DIMENSION_IDS, MAX_TARGETS, MAX_WEIGHT_DELTA, PLAN_KINDS, PLAN_IDS, RISK_LEVELS, MAX_REVIEW_PLIES, MIN_REVIEW_PLIES } from "./plan.js";

export const PROMPT_VERSION = "plan-v1";

const PLAN_MENU = PLAN_IDS.map((id) => `  - ${id}: ${PLAN_KINDS[id].help}`).join("\n");

export const PLAN_SYSTEM_PROMPT = `You are the strategy layer of a chess engine. Code plays the moves; you choose the plan.

You do not, and must not, choose a move. A separate judgement model (Jev) scores the engine's
candidate moves, and the move is selected by code from those scores. Your job is the thing code
cannot do: decide what this position is *about* over the next several moves, and tell the engine
where to look.

Choose exactly one plan from this fixed list:
${PLAN_MENU}

Then, in the same answer:
  - name up to ${MAX_TARGETS} target squares that the plan is about (real algebraic squares, lower case, e.g. "c5");
  - set risk: "hold" (consolidate, avoid weakening), "balanced", or "complicate" (unbalance, keep pieces on);
  - say how many plies of play should pass before this plan is worth re-examining (${MIN_REVIEW_PLIES}-${MAX_REVIEW_PLIES});
  - optionally shift the weights that combine the engine's search score with Jev's judgements, by at most
    ${MAX_WEIGHT_DELTA} each. Positive means "trust this more". The available weights are:
    search (the engine's own shallow search), choice (Jev's own nomination), ${DIMENSION_IDS.filter((d) => d !== "choice").join(", ")}.
    A small shift is normal; leaving the weights alone is also a valid answer;
  - optionally route Jev's attention with ask_jev, listing the dimensions worth asking about for this plan;
  - optionally guess the opponent's plan from the same list;
  - write at most two sentences of commentary for a human watching the game. Describe the plan
    and the idea behind it. Never name a specific move, and never claim the engine will play one.

Judgement you should apply:
  - If a plan is already in force and the position has not materially changed, KEEP IT. Plans that
    change every move are noise, not strategy. Say in the commentary that you are continuing.
  - Change the plan when something material happened: a pawn structure change, a piece traded, a
    weakness created or healed, the enemy king exposed, or the engine's assessment swinging.
  - Prefer the plan that fits the phase and the material: pawn-structure plans need pawns, king
    attacks need pieces, endgame plans need an endgame.
  - If you are clearly worse, "defend_hold" or "simplify" is usually right; when clearly better,
    prefer converting (endgame plans) over complicating.
  - The engine's evaluation is shallow (material and piece-square terms only, a few plies). It can
    be wrong about long-term structure and piece quality. That gap is exactly where your plan adds
    value, so do not simply echo it.

Return only the JSON object described by the schema.`;

/**
 * The response schema. Deliberately inside the documented subset: strings with enums, integers
 * with bounds, arrays of strings, and an object with schema-valued additionalProperties — no
 * `pattern`, no `allOf`, no `$ref`, and nothing requiring property order.
 */
export const PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    plan: {
      type: "string",
      enum: PLAN_IDS,
      description: "The single plan this position is about.",
    },
    targets: {
      type: "array",
      items: { type: "string", description: "A square in algebraic notation, e.g. c5." },
      description: `Up to ${MAX_TARGETS} squares the plan is about. May be empty if the plan has no square.`,
    },
    risk: {
      type: "string",
      enum: RISK_LEVELS,
      description: "How much to embrace or avoid imbalance.",
    },
    review_after_plies: {
      type: "integer",
      minimum: MIN_REVIEW_PLIES,
      maximum: MAX_REVIEW_PLIES,
      description: "Plies of play before this plan should be re-examined.",
    },
    weight_deltas: {
      type: "object",
      additionalProperties: { type: "number" },
      description: `Small adjustments to the scoring weights, each within ±${MAX_WEIGHT_DELTA}.`,
    },
    ask_jev: {
      type: "array",
      items: { type: "string", enum: DIMENSION_IDS },
      description: "Which judgements Jev should be asked about for this plan.",
    },
    opponent_plan: {
      type: "string",
      enum: PLAN_IDS,
      description: "Best guess at the opponent's plan.",
    },
    commentary: {
      type: "string",
      description: "At most two sentences for a human watching the game.",
    },
  },
  required: ["plan", "risk", "review_after_plies", "commentary"],
};

/**
 * Rough, code-computed features of a target square. Explicitly not an evaluation: it counts
 * occupant and our own legal moves landing on the square, which is enough for the model to see
 * whether pressure exists, and it is honest about being a proxy.
 */
function targetFeature(chess, square) {
  let occupant = "empty";
  for (const cell of chess.board().flat()) {
    if (cell && cell.square === square) occupant = `${cell.color === "w" ? "White" : "Black"} ${cell.type}`;
  }
  const pressure = chess.moves().filter((move) => move.to === square).length;
  return { square, occupant, ourLegalMovesToSquare: pressure };
}

/**
 * Build the strategist's input. Everything here is either a fact from the rules engine or a
 * clearly-labelled proxy — no invented commentary, so the model's own reasoning is the only
 * interpretation in play.
 *
 * @param {object} input
 * @param {object} input.chess          position (read only; not mutated)
 * @param {number|null} input.evalCp    code search score, white-positive
 * @param {string|null} input.evalLabel e.g. "+0.34"
 * @param {string|null} input.phase     Jev's read of the phase, when available
 * @param {object|null} input.plan      the plan currently in force
 * @param {number} input.pliesSinceReview
 * @param {string[]} input.lastMoves    SAN history
 * @param {{san: string, from: string, to: string, color: string}|null} input.opponentLastMove
 * @param {object|null} input.jevRead   Jev's assessment labels (standing / plan), if available
 */
export function buildPlanInput({
  chess,
  evalCp = null,
  evalLabel = null,
  phase = null,
  plan = null,
  pliesSinceReview = 0,
  lastMoves = [],
  opponentLastMove = null,
  jevRead = null,
} = {}) {
  const turn = chess.turn();
  const side = turn === "w" ? "White" : "Black";
  const lines = [];

  lines.push(`Position (FEN): ${chess.fen()}`);
  lines.push(`Side to move: ${side}, move ${chess.moveNumber?.() ?? "?"}${phase ? `, phase: ${phase}` : ""}`);
  lines.push(`Code search evaluation: ${evalLabel ?? "unknown"}${evalCp !== null ? ` (${evalCp} centipawns, White-positive)` : ""} — shallow: material and piece-square terms only`);
  lines.push(`In check: ${chess.isCheck() ? "yes" : "no"}`);
  lines.push("");
  lines.push("Board (rank 8 first, uppercase = White):");
  lines.push(boardText(chess));
  lines.push("");
  const pieces = pieceList(chess);
  lines.push(`White pieces: ${pieces.w.join(" ")}`);
  lines.push(`Black pieces: ${pieces.b.join(" ")}`);

  if (lastMoves.length > 0) {
    lines.push("");
    lines.push(`Moves so far: ${lastMoves.slice(-16).join(" ")}`);
  }
  if (opponentLastMove) {
    lines.push(`Opponent's last move: ${opponentLastMove.san} (${opponentLastMove.from}-${opponentLastMove.to})`);
  }

  if (jevRead) {
    const bits = [];
    if (jevRead.standing) bits.push(`position read: ${jevRead.standing}`);
    if (jevRead.plan) bits.push(`its own plan suggestion: ${jevRead.plan}`);
    if (bits.length) {
      lines.push("");
      lines.push(`Jev's last read of the game: ${bits.join("; ")}.`);
    }
  }

  lines.push("");
  if (plan) {
    lines.push(
      `Plan currently in force: ${plan.plan}${plan.targets?.length ? ` (targets ${plan.targets.join(", ")})` : ""}, ` +
        `risk ${plan.risk}, reviewed ${pliesSinceReview} plies ago (it asked for a review after ${plan.reviewAfterPlies}).`,
    );
    if (plan.opponentPlan) lines.push(`Your earlier guess at the opponent's plan: ${plan.opponentPlan}.`);
    if (plan.targets?.length) {
      const features = plan.targets.slice(0, MAX_TARGETS).map((square) => {
        const feature = targetFeature(chess, square);
        return `${feature.square}: ${feature.occupant}, ${feature.ourLegalMovesToSquare} of our legal moves land on it`;
      });
      lines.push(`Target features right now — ${features.join("; ")}.`);
    }
    lines.push("Decide whether to continue this plan or replace it.");
  } else {
    lines.push("No plan is in force yet. Choose one for this position.");
  }

  lines.push("");
  lines.push("Remember: choose the plan, not a move. Return only the JSON object.");
  return lines.join("\n");
}
