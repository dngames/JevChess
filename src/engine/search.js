/**
 * Shallow search + static evaluation.
 *
 * This is the code half of "code owns the rules, Jev owns the judgement": it ranks
 * every legal move so the pipelines can build a shortlist that contains no outright
 * blunder, and it supplies the evaluation bar. It is deliberately small and readable
 * rather than strong — Jev's judgement is supposed to matter.
 *
 * Two performance facts drove the design, both measured with tests/search-bench.mjs:
 *  - The rules engine keeps a 0x88 mailbox in `_board` (Int8Array(128), index
 *    rank*16 + file, rank 0 = rank 8) and encodes a piece as type | 8 (White) or
 *    type | 16 (Black). Reading that array costs nothing, whereas `board()` builds 64
 *    objects per call, which dominated the search. `evaluateChess()` uses the mailbox
 *    and falls back to the public API if the internals ever change.
 *  - A full-width search is unpredictable in cost, so `analyzeRoot()` deepens
 *    iteratively under a time and node budget and returns the deepest iteration that
 *    completed. A move therefore has a bounded cost even in a wild position.
 *
 * Everything is white-perspective internally; callers get side-to-move values where noted.
 */

export const MATE = 100_000;
export const MATE_THRESHOLD = MATE - 1_000;

export const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const TYPE_CHARS = { 1: "p", 2: "n", 3: "b", 4: "r", 5: "q", 6: "k" };

// Tomasz Michniewski's "simplified evaluation function" piece-square tables, written
// from White's point of view with a8 first, so a flat index of rank*8 + file matches.
const PST_PAWN = [
  0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0,
  20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0,
];
const PST_KNIGHT = [
  -50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5,
  -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30,
  -30, -40, -50,
];
const PST_BISHOP = [
  -20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10,
  -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10,
  -20,
];
const PST_ROOK = [
  0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0,
  -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0,
];
const PST_QUEEN = [
  -20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5,
  5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20,
];
const PST_KING_MID = [
  -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40,
  -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0,
  20, 20, 20, 30, 10, 0, 0, 10, 30, 20,
];
const PST_KING_END = [
  -50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40,
  40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50,
  -30, -30, -30, -30, -30, -30, -50,
];

const PST_BY_TYPE = [null, PST_PAWN, PST_KNIGHT, PST_BISHOP, PST_ROOK, PST_QUEEN, null];
const FILES = "abcdefgh";

// ---------------------------------------------------------------------------
// board access helpers (mailbox first, public API as a fallback)
// ---------------------------------------------------------------------------

/** The engine's 0x88 mailbox, or null if the internal layout is not what we expect. */
export function readMailbox(chess) {
  const mailbox = chess?._board;
  if (!mailbox || typeof mailbox.length !== "number" || mailbox.length < 128) return null;
  return mailbox;
}

/** Square name for a 0x88 index (0 = a8). */
export function mailboxIndexToSquare(index) {
  return `${FILES[index & 15]}${8 - (index >> 4)}`;
}

/** 0x88 index for a square name (a8 = 0). */
export function squareToMailboxIndex(square) {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  if (file < 0 || !Number.isFinite(rank)) return -1;
  return (8 - rank) * 16 + file;
}

/** Square name for a flat board index (0 = a8); kept for the public helpers below. */
export function indexToSquare(index) {
  return `${FILES[index % 8]}${8 - Math.floor(index / 8)}`;
}

/** Flat board index for a square name (a8 = 0). */
export function squareToIndex(square) {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  if (file < 0 || !Number.isFinite(rank)) return -1;
  return (8 - rank) * 8 + file;
}

/** Accept a Chess instance, a flat 64-cell board, or a nested 8x8 board. */
function normalizeBoard(input) {
  if (input && typeof input.moves === "function") {
    const board = input.board();
    return Array.isArray(board[0]) ? board.flat() : board;
  }
  if (Array.isArray(input)) return Array.isArray(input[0]) ? input.flat() : input;
  return [];
}

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

/**
 * Static evaluation in centipawns from White's point of view, straight off the 0x88
 * mailbox. Material + piece-square tables + bishop pair + pawn structure + passed pawns.
 */
export function evaluateWhiteMailbox(mailbox, turn) {
  let score = 0;
  let phase = 0;
  const pawnFilesW = [0, 0, 0, 0, 0, 0, 0, 0];
  const pawnFilesB = [0, 0, 0, 0, 0, 0, 0, 0];
  const pawnsW = [];
  const pawnsB = [];
  let bishopsW = 0;
  let bishopsB = 0;
  let queens = 0;
  let rooks = 0;
  let minors = 0;

  for (let r = 0; r < 8; r += 1) {
    const rowBase = r * 16;
    for (let f = 0; f < 8; f += 1) {
      const code = mailbox[rowBase + f];
      if (code === 0) continue;
      const type = code & 7;
      const isWhite = (code & 8) !== 0;
      if (type === 1) {
        if (isWhite) {
          pawnFilesW[f] += 1;
          pawnsW.push(r * 8 + f);
        } else {
          pawnFilesB[f] += 1;
          pawnsB.push(r * 8 + f);
        }
      } else if (type === 2) minors += 1;
      else if (type === 3) {
        minors += 1;
        if (isWhite) bishopsW += 1;
        else bishopsB += 1;
      } else if (type === 4) rooks += 1;
      else if (type === 5) queens += 1;
      if (type !== 1 && type !== 6) phase += PIECE_VALUE[TYPE_CHARS[type]];
    }
  }

  const endgame = phase <= 1300;
  const kingTable = endgame ? PST_KING_END : PST_KING_MID;

  for (let r = 0; r < 8; r += 1) {
    const rowBase = r * 16;
    for (let f = 0; f < 8; f += 1) {
      const code = mailbox[rowBase + f];
      if (code === 0) continue;
      const type = code & 7;
      const isWhite = (code & 8) !== 0;
      const flat = r * 8 + f;
      const table = type === 6 ? kingTable : PST_BY_TYPE[type];
      const index = isWhite ? flat : flat ^ 56;
      const value = PIECE_VALUE[TYPE_CHARS[type]] + (table ? table[index] : 0);
      score += isWhite ? value : -value;
    }
  }

  if (bishopsW >= 2) score += 30;
  if (bishopsB >= 2) score -= 30;

  score += pawnStructureScore(pawnFilesW, pawnsW, pawnFilesB);
  score -= pawnStructureScore(pawnFilesB, pawnsB, pawnFilesW);

  return Math.round(score);
}

/**
 * Doubled, isolated and passed pawn terms for one side, from pawn files alone.
 * @param {number[]} ownFiles   pawn counts per file for this side
 * @param {number[]} ownPawns   flat indexes (rank*8 + file) of this side's pawns
 * @param {number[]} enemyFiles pawn counts per file for the opponent
 */
function pawnStructureScore(ownFiles, ownPawns, enemyFiles) {
  let score = 0;
  for (let file = 0; file < 8; file += 1) {
    const count = ownFiles[file];
    if (count > 1) score -= 12 * (count - 1);
    if (count > 0 && (ownFiles[file - 1] ?? 0) === 0 && (ownFiles[file + 1] ?? 0) === 0) score -= 14;
  }
  for (const flat of ownPawns) {
    const file = flat % 8;
    const rank = 8 - Math.floor(flat / 8); // real rank 2..7
    // Only a passed pawn — no enemy pawn on this or an adjacent file — earns a bonus.
    const blocked = (enemyFiles[file] ?? 0) > 0 || (enemyFiles[file - 1] ?? 0) > 0 || (enemyFiles[file + 1] ?? 0) > 0;
    if (blocked) continue;
    const advance = rank > 4 ? rank - 2 : 7 - rank;
    score += 8 + advance * 6;
  }
  return score;
}

/** Board-array fallback, accepting flat or nested input. */
export function evaluateWhite(boardInput) {
  const board = normalizeBoard(boardInput);
  let score = 0;
  for (let i = 0; i < 64; i += 1) {
    const cell = board[i];
    if (!cell || !cell.type || !cell.color) continue;
    const table = cell.type === "k" ? PST_KING_MID : PST_BY_TYPE[{ p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 }[cell.type]];
    const index = cell.color === "w" ? i : i ^ 56;
    const value = PIECE_VALUE[cell.type] + (table ? table[index] : 0);
    score += cell.color === "w" ? value : -value;
  }
  return Math.round(score);
}

/** Fast path used by the search; falls back to the public API if internals differ. */
export function evaluateChess(chess) {
  const mailbox = readMailbox(chess);
  if (mailbox) return evaluateWhiteMailbox(mailbox, chess.turn());
  return evaluateWhite(chess);
}

/** Material on both sides from a Chess instance, a flat board, or a nested board. */
export function materialCount(input) {
  const total = { w: 0, b: 0 };
  if (input && typeof input._board !== "undefined") {
    const mailbox = readMailbox(input);
    if (mailbox) {
      for (let r = 0; r < 8; r += 1) {
        for (let f = 0; f < 8; f += 1) {
          const code = mailbox[r * 16 + f];
          if (code === 0) continue;
          total[(code & 8) !== 0 ? "w" : "b"] += PIECE_VALUE[TYPE_CHARS[code & 7]] ?? 0;
        }
      }
      return total;
    }
  }
  for (const cell of normalizeBoard(input)) {
    if (!cell || !cell.color) continue;
    total[cell.color] += PIECE_VALUE[cell.type] ?? 0;
  }
  return total;
}

/** "even" / "+3 for White" style label. */
export function materialLabel(input) {
  const { w, b } = materialCount(input);
  const diff = Math.round((w - b) / 100);
  if (diff === 0) return "material is level";
  return `material is +${Math.abs(diff)} for ${diff > 0 ? "White" : "Black"}`;
}

/** Map a centipawn score to 0..1 with a logistic curve (150cp ≈ 0.73). */
export function cpToUnit(cp, scale = 150) {
  return 1 / (1 + Math.exp(-cp / scale));
}

// ---------------------------------------------------------------------------
// root analysis
// ---------------------------------------------------------------------------

/**
 * Rank every legal move for the side to move.
 *
 * Iterative deepening under a budget: each completed iteration replaces the previous
 * ordering, and a partial iteration is thrown away. The result always contains a score
 * for every legal move, so the caller can build a shortlist even if the budget only
 * allowed a one-ply look.
 *
 * @param {object} chess
 * @param {{depth?:number, quiescence?:number, timeBudgetMs?:number, nodeBudget?:number}} [options]
 * @returns {{
 *   moves: Array<{san:string,from:string,to:string,promotion:string|null,captured:string|null,
 *                 flags:string,cp:number,mateIn:number|null,unit:number,rank:number,move:object}>,
 *   bestCp:number, bestUnit:number, whiteCp:number, nodes:number, depth:number,
 *   depthRequested:number, aborted:boolean, elapsedMs:number
 * }}
 */
export function analyzeRoot(chess, { depth = 3, quiescence = 2, timeBudgetMs = 1500, nodeBudget = 400_000 } = {}) {
  const startedAt = Date.now();
  const context = { nodes: 0, deadline: startedAt + timeBudgetMs, nodeBudget, aborted: false };
  const turn = chess.turn();
  const legal = chess.moves();

  const staticOrder = legal.map((move) => ({ move, cp: staticMoveScore(chess, move) }));
  let scored = staticOrder;
  let reachedDepth = 0;

  for (let currentDepth = 1; currentDepth <= depth; currentDepth += 1) {
    const ordered = orderRootMoves(legal, scored);
    const partial = [];
    let aborted = false;
    for (const move of ordered) {
      chess.move(move);
      const cp = -negamax(chess, currentDepth - 1, -Infinity, Infinity, quiescence, 1, context);
      chess.undo();
      if (context.aborted) {
        aborted = true;
        break;
      }
      partial.push({ move, cp });
    }
    if (aborted || partial.length !== legal.length) break;
    scored = partial;
    reachedDepth = currentDepth;
    if (Math.abs(scored[0]?.cp ?? 0) > MATE_THRESHOLD) break; // a forced mate is found; stop
  }

  scored = [...scored].sort((a, b) => b.cp - a.cp || String(a.move?.san).localeCompare(String(b.move?.san)));

  const moves = scored.map((entry, index) => {
    const move = entry.move ?? {};
    const cp = entry.cp;
    const mateIn = Math.abs(cp) > MATE_THRESHOLD ? (cp > 0 ? Math.ceil((MATE - cp) / 2) : -Math.ceil((MATE + cp) / 2)) : null;
    return {
      san: move.san ?? `${move.from}${move.to}`,
      from: move.from,
      to: move.to,
      promotion: move.promotion ?? null,
      captured: move.captured ?? null,
      flags: typeof move.flags === "string" ? move.flags : "",
      piece: move.piece ?? null,
      cp,
      mateIn,
      unit: cpToUnit(cp),
      rank: index + 1,
      move,
    };
  });

  const bestCp = moves[0]?.cp ?? 0;
  return {
    moves,
    bestCp,
    bestUnit: moves[0]?.unit ?? 0.5,
    // The search score refers to the side to move; the eval bar is white-centric.
    whiteCp: turn === "w" ? bestCp : -bestCp,
    nodes: context.nodes,
    depth: reachedDepth,
    depthRequested: depth,
    aborted: reachedDepth < depth,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Cheap one-ply ordering for the first iteration and for a truncated search. */
function staticMoveScore(chess, move) {
  let score = 0;
  if (move.captured) score += 10 * (PIECE_VALUE[move.captured] ?? 0) - (PIECE_VALUE[move.piece] ?? 0);
  if (move.promotion) score += 800;
  return score;
}

function orderRootMoves(legal, scored) {
  const bySan = new Map(scored.map((entry) => [entry.move?.san, entry.cp]));
  return [...legal].sort(
    (a, b) => (bySan.get(b.san) ?? -Infinity) - (bySan.get(a.san) ?? -Infinity) || String(b.san).localeCompare(String(a.san)),
  );
}

function negamax(chess, depth, alpha, beta, quiescence, ply, context) {
  context.nodes += 1;
  if ((context.nodes & 1023) === 0 && (Date.now() > context.deadline || context.nodes > context.nodeBudget)) {
    context.aborted = true;
  }
  if (context.aborted) return 0;

  // Cheap draw checks first; the rules engine answers these without generating moves.
  if (chess.isInsufficientMaterial() || chess.isFiftyMoveDraw() || chess.isThreefoldRepetition()) return 0;
  if (depth <= 0) return quiesce(chess, alpha, beta, quiescence, ply, context);

  // One move generation decides mate and stalemate, instead of asking the engine
  // isCheckmate() and then generating the same moves again.
  const moves = chess.moves();
  if (moves.length === 0) return chess.isCheck() ? -MATE + ply : 0;

  let best = -Infinity;
  for (const move of orderMoves(moves)) {
    chess.move(move);
    const value = -negamax(chess, depth - 1, -beta, -alpha, quiescence, ply + 1, context);
    chess.undo();
    if (context.aborted) return 0;
    if (value > best) best = value;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best === -Infinity ? 0 : best;
}

/** Captures first, biggest victim first — the cheapest useful ordering. */
function orderMoves(moves) {
  let hasCapture = false;
  for (const move of moves) {
    if (move.captured || move.promotion) {
      hasCapture = true;
      break;
    }
  }
  if (!hasCapture) return moves;
  return [...moves].sort((a, b) => moveOrderScore(b) - moveOrderScore(a));
}

function moveOrderScore(move) {
  let score = 0;
  if (move.captured) score += 10 * (PIECE_VALUE[move.captured] ?? 0) - (PIECE_VALUE[move.piece] ?? 0);
  if (move.promotion) score += 800;
  return score;
}

function quiesce(chess, alpha, beta, depth, ply, context) {
  context.nodes += 1;
  if ((context.nodes & 1023) === 0 && (Date.now() > context.deadline || context.nodes > context.nodeBudget)) {
    context.aborted = true;
  }
  if (context.aborted) return 0;

  const white = evaluateChess(chess);
  const standPat = chess.turn() === "w" ? white : -white;
  if (depth <= 0) return standPat;

  // One generation decides mate/stalemate and supplies the noisy moves.
  const all = chess.moves();
  if (all.length === 0) return chess.isCheck() ? -MATE + ply : 0;

  if (standPat >= beta) return beta;
  if (standPat > alpha) alpha = standPat;

  const noisy = all.filter((move) => move.captured || move.promotion);
  let best = standPat;
  for (const move of orderMoves(noisy)) {
    // Delta pruning: if even winning the captured piece leaves us below alpha, the
    // capture cannot change the result, so do not spend a subtree on it.
    const gain = (PIECE_VALUE[move.captured] ?? 0) + (move.promotion ? 800 : 0);
    if (standPat + gain + 120 < alpha) continue;
    chess.move(move);
    const value = -quiesce(chess, -beta, -alpha, depth - 1, ply + 1, context);
    chess.undo();
    if (context.aborted) return 0;
    if (value > best) best = value;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

export { orderMoves, orderRootMoves };
