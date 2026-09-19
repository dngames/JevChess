/**
 * EVERY question Jev is asked for a move, and every threshold, lives in this file.
 *
 * Design rules this file follows (from the TypeSafe docs and skill):
 *  - One narrow judgment per question. A Score question measures one dimension, never
 *    "how good and also how safe and also how pretty".
 *  - Levels describe concrete situations, never degrees ("drops a pawn for nothing",
 *    not "moderately bad"). Each level is judged on its own, so no level may refer to
 *    its neighbours or to a number.
 *  - Every question sees the same `state` and is answered in parallel and in isolation,
 *    so per-candidate questions must name the candidate explicitly.
 *  - Jev cannot search. Code supplies the facts (boards, captures, checks, material);
 *    Jev supplies the judgement.
 *  - Jev is NOT shown the code's search ranking (see `includeSearchHints` in strategies.js).
 *    If it saw "the engine likes candidate 4 best" it would anchor on that and its own
 *    read of the position would stop carrying information. The composite step is where
 *    the search and Jev's judgement are combined, with weights you can see.
 *
 * The wording below is meant to be edited by a human — tune it against real games and
 * re-run `npm run experiment` before trusting a change.
 */

// ---------------------------------------------------------------------------
// Score dimensions. Each becomes one question per candidate move.
// `levels` run low (0) to high (3) and are normalized by pipelines.js.
// ---------------------------------------------------------------------------

export const DIMENSIONS = {
  quality: {
    label: "Move quality",
    help: "Overall judgement of the move on its own merits.",
    instructions: (ctx) =>
      `Candidate ${ctx.candidate.id} is ${ctx.side.name}'s move ${ctx.candidate.san} ` +
      `(${ctx.candidate.description}). Judge that move on its own merits as a chess move, ` +
      `using the position before the move and the board shown for candidate ${ctx.candidate.id} ` +
      `under \`candidates\`.`,
    levels: (ctx) => [
      "It loses material for nothing, walks into a forced mate, or leaves a major piece where it can simply be taken: a serious error any club player would avoid.",
      `It is playable but clearly gives something away: it drops a pawn or an exchange, wastes what the position was about, or hands ${ctx.opponent.name} the initiative for free.`,
      `It is sound: nothing is given away, and the position stays roughly as good as it was, but it creates no particular problem for ${ctx.opponent.name}.`,
      `It is the best kind of move available here: it wins material, forces mate, or creates a threat so strong that ${ctx.opponent.name} must spend the next moves answering it.`,
    ],
  },

  safety: {
    label: "Material safety",
    help: "How exposed this move leaves the mover's own material.",
    instructions: (ctx) =>
      `After candidate ${ctx.candidate.id} (${ctx.candidate.san}), how safe is ${ctx.side.name}'s ` +
      `material from an immediate refutation by ${ctx.opponent.name}? Judge only the danger in ` +
      `${ctx.opponent.name}'s next moves, not the long-term position.`,
    levels: (ctx) => [
      `Immediately punishable: ${ctx.opponent.name} can win material outright, or deliver mate, with a single next move.`,
      `Shaky: ${ctx.opponent.name} has a strong forcing reply such as a check, a fork, or a threat that wins material within a couple of moves.`,
      `Solid enough: nothing is lost by force, although ${ctx.opponent.name} has an equal trade or a mildly annoying move available.`,
      `Nothing to worry about: every ${ctx.side.name} piece is defended or out of reach, and ${ctx.opponent.name} has no forcing reply at all.`,
    ],
  },

  activity: {
    label: "Piece activity",
    help: "Development, mobility and coordination after the move.",
    instructions: (ctx) =>
      `After candidate ${ctx.candidate.id} (${ctx.candidate.san}), how well are ${ctx.side.name}'s ` +
      `pieces placed for the play ahead: do they have room, work together, and cover useful squares?`,
    levels: () => [
      "Worse placed: the move blocks its own pieces, leaves them short of squares, or strands a piece away from the action.",
      "Not improved: the pieces are no better placed than before and nothing new is coordinated.",
      "Better: one previously passive piece is developed, centralised, or given a clear line, and the pieces start working together.",
      "Excellent: it activates several pieces at once, or turns a passive position into a lasting initiative with an obvious plan.",
    ],
  },

  kingPressure: {
    label: "Pressure on the enemy king",
    help: "How much danger the move creates for the opponent's king.",
    instructions: (ctx) =>
      `After candidate ${ctx.candidate.id} (${ctx.candidate.san}), how much danger does ${ctx.side.name} ` +
      `create for ${ctx.opponent.name}'s king?`,
    levels: (ctx) => [
      `No danger at all: no ${ctx.side.name} piece attacks or even aims at the squares around ${ctx.opponent.name}'s king.`,
      `A hint of pressure: a piece is pointed towards ${ctx.opponent.name}'s king, but nothing is threatened yet.`,
      `Real attacking pressure: ${ctx.side.name} threatens a check, a pin, or a capture near ${ctx.opponent.name}'s king, or has just opened a line against it.`,
      `A decisive attack: ${ctx.side.name} threatens mate, or a forced win of material, around ${ctx.opponent.name}'s king.`,
    ],
  },

  kingSafety: {
    label: "Own king safety",
    help: "Protection of the mover's own king after the move.",
    instructions: (ctx) =>
      `After candidate ${ctx.candidate.id} (${ctx.candidate.san}), how well protected is ${ctx.side.name}'s ` +
      `own king, counting its pawn cover and the pieces that defend it?`,
    levels: (ctx) => [
      `Exposed: the king's cover is broken or missing and ${ctx.opponent.name}'s pieces are closing in.`,
      `Weak: there are gaps or a pin near ${ctx.side.name}'s king that ${ctx.opponent.name} can attack right away.`,
      "Adequate: the king is sheltered and faces only ordinary pressure.",
      "Safe: intact pawns shield the king, pieces defend the approach squares, and no realistic attack exists.",
    ],
  },

  pawnStructure: {
    label: "Pawn structure",
    help: "Effect of the move on the mover's pawns.",
    instructions: (ctx) =>
      `After candidate ${ctx.candidate.id} (${ctx.candidate.san}), how healthy is ${ctx.side.name}'s pawn structure?`,
    levels: () => [
      "Damaged: it creates doubled, isolated or backward pawns that can be attacked and cannot easily be defended.",
      "Loosened: it leaves pawn weaknesses that will need care later.",
      "Neutral: the pawns stay sound and no new weakness appears.",
      "Improved: it repairs a weakness, or creates a strong connected or passed pawn.",
    ],
  },

  endgameTechnique: {
    label: "Endgame technique",
    help: "Progress towards converting (or holding) an endgame.",
    instructions: (ctx) =>
      `After candidate ${ctx.candidate.id} (${ctx.candidate.san}), how much closer does the move bring ` +
      `${ctx.side.name} to converting a winning endgame, or to holding a drawn one? Judge technical ` +
      `endgame progress only.`,
    levels: (ctx) => [
      `Counterproductive: it lets ${ctx.opponent.name} trade into a drawn or lost endgame, or throws away a winning one.`,
      `Drifting: no progress is made and ${ctx.opponent.name} can hold comfortably.`,
      "Useful: the king, a pawn or a piece takes a better square for the endgame that is coming.",
      "Decisive technique: it forces a won endgame, a decisive king invasion, or a trade into a winning pawn ending.",
    ],
  },
};

export const DIMENSION_IDS = Object.keys(DIMENSIONS);

// ---------------------------------------------------------------------------
// Whole-position questions, asked in the same request as the candidate ones.
// They cost almost nothing (they run in parallel) and give the UI Jev's read of the
// game rather than only its read of the move.
// ---------------------------------------------------------------------------

export function buildAssessmentQuestions(ctx) {
  return {
    standing: {
      type: "choice",
      instructions:
        "Ignoring the candidate moves listed under `candidates`, which side stands better in the " +
        "position described under `position`?",
      criteria: {
        white: "White has the clearly better position",
        black: "Black has the clearly better position",
        equal: "The position is balanced; neither side has a clear advantage",
      },
    },
    phase: {
      type: "choice",
      instructions: "What stage of the game is the position under `position` in?",
      criteria: {
        opening: "Opening: pieces are still mostly undeveloped and the kings have not settled",
        middlegame: "Middlegame: most pieces are developed and the kings are castled or under pressure",
        endgame: "Endgame: most pieces are gone and kings and pawns matter most",
      },
    },
    plan: {
      type: "choice",
      instructions: `What is ${ctx.side.name}'s most sensible plan in the position under \`position\`, ` +
        "before considering the candidate moves?",
      criteria: {
        attack_king: `Attack ${ctx.opponent.name}'s king with pieces and pawns`,
        win_material: "Win material with a tactic or by attacking an undefended piece",
        improve_pieces: "Improve the worst-placed piece and wait for a better moment",
        trade_to_endgame: "Trade pieces to reach a favourable endgame",
        defend_hold: "Defend carefully and hold the position together",
      },
    },
  };
}

/** The candidate ids referenced by assessment answers, for `readChoiceAnswer`. */
export const ASSESSMENT_IDS = ["standing", "phase", "plan"];

// ---------------------------------------------------------------------------
// Candidate questions: one Choice over the whole shortlist, plus one Score per
// (candidate, dimension) pair. All in a single request.
// ---------------------------------------------------------------------------

/**
 * @param {Array<{id:string,san:string,description:string,summary:string}>} candidates
 * @param {{dims:string[]}} opts
 * @param {{side:object,opponent:object}} ctx
 */
export function buildCandidateQuestions(candidates, { dims }, ctx) {
  const questions = {};
  const index = [];

  questions.best_move = {
    type: "choice",
    instructions:
      `Which single candidate move is best for ${ctx.side.name}? Compare the position before the ` +
      "move with the board shown for each candidate under `candidates`.",
    criteria: Object.fromEntries(candidates.map((candidate) => [`${candidate.id} ${candidate.san}`, candidate.summary])),
  };

  for (const candidate of candidates) {
    for (const dim of dims) {
      const definition = DIMENSIONS[dim];
      if (!definition) continue;
      const id = `cand_${candidate.id}_${dim}`;
      questions[id] = {
        type: "score",
        instructions: definition.instructions({ ...ctx, candidate }),
        criteria: definition.levels({ ...ctx, candidate }),
      };
      index.push({ id, candidateId: candidate.id, dim });
    }
  }

  return { questions, index };
}

// ---------------------------------------------------------------------------
// Audit questions — the "nominate, then verify" pipeline. After Jev has nominated a
// move, code asks Jev whether the nomination survives its own scrutiny, and vetoes it
// if it does not. These are deliberately gut-check questions about consequences.
// ---------------------------------------------------------------------------

export function buildAuditQuestions({ san, side, opponent }) {
  return {
    audit_hangs_material: {
      type: "noul",
      instructions: `After ${side.name} plays ${san}, can ${opponent.name} win material for free with their next move?`,
      criteria: {
        true: `A ${side.name} piece or pawn can be captured and ${opponent.name} comes out ahead in material`,
        false: `Nothing of ${side.name}'s can be taken for free`,
      },
    },
    audit_opponent_forcing: {
      type: "noul",
      instructions: `After ${side.name} plays ${san}, does ${opponent.name} have a strong forcing reply such as a check, a fork, or a mating threat?`,
      criteria: {
        true: `A serious forcing reply exists that ${side.name} must answer`,
        false: `No forcing reply; ${opponent.name} has only ordinary moves`,
      },
    },
    audit_regret: {
      type: "noul",
      instructions: `${side.name} plays ${san}. On reflection, is this a move ${side.name} would want to take back?`,
      criteria: {
        true: "There is a clearly better alternative that a strong player would choose instead",
        false: "It is a reasonable choice; there is no regret",
      },
    },
    audit_gives_away_advantage: {
      type: "noul",
      instructions: `Does ${san} throw away an advantage ${side.name} had in the position before the move?`,
      criteria: {
        true: `${side.name} was better and this move gives that up`,
        false: `${side.name} had no advantage to give away, or keeps it`,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Thresholds for the audit pipeline. All in one place so they are easy to review.
// A veto means "exclude this move, ask Jev again".
// ---------------------------------------------------------------------------

export const STRATEGY_TUNING = {
  /** Probability that the nomination loses material → veto. */
  hangVeto: 0.5,
  /** Probability that Jev regrets the move → veto. */
  regretVeto: 0.7,
  /** Probability that the move gives away an existing advantage → veto. */
  advantageVeto: 0.75,
  /** How many nominated moves may be vetoed before the pipeline gives up and defers. */
  maxVetoes: 3,
  /** Above this, `audit_opponent_forcing` is shown as a warning but does not veto. */
  forcingWarning: 0.8,
};

// ---------------------------------------------------------------------------
// Reading answers back. Jev's structured output should always be well formed, but a
// chess game must not die because one answer arrived odd, so everything is clamped.
// ---------------------------------------------------------------------------

/** Normalize a Score answer to 0..1 using its own level count. */
export function readScoreAnswer(answer, levelCount) {
  if (!answer || typeof answer !== "object") return null;
  const top = Math.max(1, levelCount - 1);
  const raw = typeof answer.score === "number" ? answer.score : Number(answer.score);
  if (!Number.isFinite(raw)) return null;
  return clamp01(raw / top);
}

/** A Noul answer is already a probability in 0..1. */
export function readNoulAnswer(answer) {
  if (!answer || typeof answer !== "object") return null;
  const value = typeof answer.noul === "number" ? answer.noul : Number(answer.noul);
  if (!Number.isFinite(value)) return null;
  return clamp01(value);
}

/**
 * Read a Choice answer. Returns the chosen key plus probabilities restricted to
 * `validKeys` and renormalized, so an invented option cannot win.
 */
export function readChoiceAnswer(answer, validKeys) {
  const valid = new Set(validKeys ?? []);
  const probabilities = {};
  if (answer && typeof answer.probabilities === "object" && answer.probabilities) {
    for (const [key, value] of Object.entries(answer.probabilities)) {
      if (valid.size && !valid.has(key)) continue;
      const numeric = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(numeric) && numeric > 0) probabilities[key] = numeric;
    }
  }
  const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
  if (total > 0) {
    for (const key of Object.keys(probabilities)) probabilities[key] = probabilities[key] / total;
  }
  let choice = typeof answer?.choice === "string" ? answer.choice : null;
  if (choice && valid.size && !valid.has(choice)) {
    // Jev named something that is not on the list. Fall back to the best valid
    // probability if there is one; otherwise report "invalid" and let the caller decide.
    const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
    choice = best ? best[0] : null;
    if (!choice) return { choice: null, probabilities, invalid: answer?.choice ?? null };
    return { choice, probabilities, invalid: answer.choice };
  }
  return { choice, probabilities, invalid: null };
}

export function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
