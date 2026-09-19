/**
 * Builds the `state` object sent to Jev.
 *
 * Jev is a language model that does not search, so it cannot work out what a board
 * looks like after a move unless we show it. The state therefore contains, for each
 * candidate: the plain-language move, the machine-checkable facts about it, and (for
 * shortlists) the diagram of the position after it. Facts come from the rules engine,
 * so they are always true; judgement is left to Jev.
 *
 * Two deliberate omissions, both switchable in src/strategies.js:
 *  - `includeSearchHints` (default off): the code search's ranking is never included
 *    by default. If Jev read "the engine likes candidate 4 best" it would anchor on
 *    it, and its own judgement would stop carrying information.
 *  - `exposeCaptureEvidence` (default off): listing the captures available to the
 *    opponent makes the `safety` dimension almost mechanical and duplicates what the
 *    search already knows. It exists as an experiment switch.
 */

const FILE_LETTERS = "abcdefgh";
const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const LETTERS = { p: "P", n: "N", b: "B", r: "R", q: "Q", k: "K" };

export function sideName(color) {
  return color === "w" ? "White" : "Black";
}

export function otherColor(color) {
  return color === "w" ? "b" : "w";
}

/** A readable diagram. Uppercase = White, "." = empty. Rank 8 prints first. */
export function boardText(input) {
  const board = flatBoard(input);
  const lines = [];
  for (let row = 0; row < 8; row += 1) {
    const rank = 8 - row;
    const cells = [];
    for (let col = 0; col < 8; col += 1) {
      const cell = board[row * 8 + col];
      if (!cell || !cell.type) cells.push(".");
      else cells.push(cell.color === "w" ? LETTERS[cell.type] : LETTERS[cell.type].toLowerCase());
    }
    lines.push(`${rank}  ${cells.join(" ")}`);
  }
  lines.push(`   ${FILE_LETTERS.split("").join(" ")}`);
  return lines.join("\n");
}

/**
 * One flat list of 64 cells, rank 8 first, whatever shape we were handed: a Chess
 * instance (whose `board()` is a nested 8x8 array of rows), a nested array, or an
 * already-flat array. Every helper below normalizes here so a nested board can never
 * silently produce "undefined" cells.
 */
export function flatBoard(input) {
  if (input && typeof input.board === "function") return flatBoard(input.board());
  if (!Array.isArray(input)) return [];
  return Array.isArray(input[0]) ? input.flat() : input;
}

/** Pieces grouped by type, e.g. ["Ke1", "Ra1", "Ra8", ...]. */
export function pieceList(input) {
  const board = flatBoard(input);
  const order = ["k", "q", "r", "b", "n", "p"];
  const result = { w: [], b: [] };
  for (const cell of board) {
    if (!cell || !cell.type || !cell.color) continue;
    result[cell.color].push(`${LETTERS[cell.type]}${cell.square}`);
  }
  for (const color of ["w", "b"]) {
    result[color].sort((a, b) => order.indexOf(a[0].toLowerCase()) - order.indexOf(b[0].toLowerCase()) || a.localeCompare(b));
  }
  return result;
}

/** Plain-language description of a move, from the mover's point of view. */
export function describeMove(chess, move) {
  const board = flatBoard(chess);
  const piece = board.find((cell) => cell && cell.square === move.from) ?? null;
  const pieceName = piece ? PIECE_NAMES[piece.type] : "piece";
  const parts = [];

  if (move.flags?.includes?.("k")) {
    return `the king castles kingside: the king goes from ${move.from} to ${move.to} and the rook from h${move.from[1]} to f${move.from[1]}`;
  }
  if (move.flags?.includes?.("q")) {
    return `the king castles queenside: the king goes from ${move.from} to ${move.to} and the rook from a${move.from[1]} to d${move.from[1]}`;
  }
  if (move.flags?.includes?.("e")) {
    parts.push(
      `the ${pieceName} on ${move.from} captures the ${otherColor(move.color) === "w" ? "White" : "Black"} pawn on ${move.to} en passant`,
    );
  } else if (move.captured) {
    parts.push(`the ${pieceName} on ${move.from} captures the ${PIECE_NAMES[move.captured]} on ${move.to}`);
  } else {
    parts.push(`the ${pieceName} on ${move.from} moves to ${move.to}`);
  }
  if (move.promotion) {
    parts.push(`and promotes to a ${PIECE_NAMES[move.promotion] ?? move.promotion}`);
  }
  return parts.join(" ");
}

/**
 * @param {object} opts
 * @param {object} opts.chess        position to analyse (will be mutated with move/undo)
 * @param {Array}  opts.candidates   [{ id, move }] — move objects from chess.moves()
 * @param {string[]} [opts.lastMovesSan]
 * @param {boolean} [opts.includeBoards=true]
 * @param {boolean} [opts.exposeCaptureEvidence=false]
 * @param {boolean} [opts.includeSearchHints=false]
 * @param {number|null} [opts.searchCp]  only used when includeSearchHints is on
 * @param {"judge"|"audit"} [opts.task]
 */
export function buildJevState({
  chess,
  candidates,
  lastMovesSan = [],
  includeBoards = true,
  exposeCaptureEvidence = false,
  includeSearchHints = false,
  searchCpBySan = null,
  task = "judge",
} = {}) {
  const turn = chess.turn();
  const side = sideName(turn);
  const opponent = sideName(otherColor(turn));
  const positionBoard = flatBoard(chess);

  const state = {
    game: "chess",
    task:
      task === "audit"
        ? `${side} has nominated a move. Judge whether that move survives scrutiny.`
        : `Judge ${side}'s candidate moves and choose the best one for ${side}.`,
    conventions: {
      board:
        "Board diagrams list rank 8 first and rank 1 last; within a rank, files run a to h. " +
        "Uppercase letters are White's pieces (K Q R B N P), lowercase letters are Black's (k q r b n p), " +
        "and . is an empty square. Moves are in standard algebraic notation (SAN) from the side to move's point of view.",
      note: "The facts listed for each candidate were computed by a chess rules engine and can be trusted. Judgement is yours.",
    },
    position: {
      fen: chess.fen(),
      side_to_move: side,
      move_number: chess.moveNumber?.() ?? 1,
      in_check: chess.isCheck(),
      can_castle: castlingDescription(chess),
      en_passant_target: enPassantTarget(chess.fen()),
      material_balance: materialSentence(positionBoard),
      pieces: pieceList(positionBoard),
      board_8_to_1: boardText(positionBoard),
    },
    recent_moves_san: lastMovesSan.slice(-12),
  };

  state.candidates = candidates.map(({ id, move }, index) => {
    const applied = chess.move(move) ?? move;
    const boardAfter = flatBoard(chess);
    const opponentReplies = chess.moves().length;
    const opponentInCheck = chess.isCheck();
    const opponentCaptures = exposeCaptureEvidence ? availableCaptures(chess) : null;
    chess.undo();

    const entry = {
      id,
      move_san: applied.san ?? `${move.from}${move.to}`,
      how_the_move_reads: describeMove(chess, applied),
      piece: PIECE_NAMES[movePieceType(chess, move)] ?? "piece",
      from: applied.from,
      to: applied.to,
      captures: applied.captured ? PIECE_NAMES[applied.captured] : "nothing",
      is_castle: applied.flags?.includes?.("k") ? "kingside" : applied.flags?.includes?.("q") ? "queenside" : null,
      promotes_to: applied.promotion ? PIECE_NAMES[applied.promotion] : null,
      gives_check: opponentInCheck,
      opponent_legal_replies: opponentReplies,
      material_after: materialCountsSentence(boardAfter),
    };
    if (includeBoards) entry.board_after_8_to_1 = boardText(boardAfter);
    if (opponentCaptures) entry.opponent_captures_available = opponentCaptures;
    if (includeSearchHints && searchCpBySan) {
      const cp = searchCpBySan[applied.san] ?? searchCpBySan[move.san];
      if (typeof cp === "number") entry.code_search_hint_centipawns = cp;
    }
    return entry;
  });

  if (candidates.length === 0) state.candidates = [];

  return state;
}

/** Compact state for the audit call: the position plus the one nominated move. */
export function buildAuditState({ chess, move, lastMovesSan = [] }) {
  const turn = chess.turn();
  const boardBefore = flatBoard(chess);
  const applied = chess.move(move) ?? move;
  const boardAfter = flatBoard(chess);
  const replies = chess.moves();
  const capturingReplies = replies.filter((reply) => reply.captured).map((reply) => reply.san);
  chess.undo();

  return {
    game: "chess",
    task: `Judge whether ${sideName(turn)}'s nominated move is sound.`,
    conventions: {
      board:
        "Board diagrams list rank 8 first. Uppercase letters are White's pieces, lowercase are Black's, " +
        "and . is an empty square. Moves are in standard algebraic notation (SAN).",
    },
    position: {
      fen: chess.fen(),
      side_to_move: sideName(turn),
      move_number: chess.moveNumber?.() ?? 1,
      in_check: chess.isCheck(),
      material_balance: materialSentence(boardBefore),
      board_8_to_1: boardText(boardBefore),
    },
    recent_moves_san: lastMovesSan.slice(-12),
    nomination: {
      move_san: applied.san ?? `${move.from}${move.to}`,
      how_the_move_reads: describeMove(chess, applied),
      capturable_replies_for_opponent: capturingReplies.slice(0, 6),
      opponent_legal_replies: replies.length,
      board_after_8_to_1: boardText(boardAfter),
    },
  };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function movePieceType(chess, move) {
  const board = flatBoard(chess);
  const cell = board.find((entry) => entry && entry.square === move.from);
  return cell?.type ?? "p";
}

export function materialCountsSentence(input) {
  let white = 0;
  let black = 0;
  for (const cell of flatBoard(input)) {
    if (!cell || !cell.type || !cell.color) continue;
    if (cell.type === "k") continue;
    const value = { p: 1, n: 3, b: 3, r: 5, q: 9 }[cell.type] ?? 0;
    if (cell.color === "w") white += value;
    else black += value;
  }
  return `White has ${white} points of material, Black has ${black}`;
}

export function materialSentence(input) {
  let white = 0;
  let black = 0;
  for (const cell of flatBoard(input)) {
    if (!cell || !cell.type || !cell.color) continue;
    const value = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }[cell.type] ?? 0;
    if (cell.color === "w") white += value;
    else black += value;
  }
  const diff = white - black;
  if (diff === 0) return "Material is level";
  return diff > 0 ? `White is ahead by ${diff} points` : `Black is ahead by ${-diff} points`;
}

function castlingDescription(chess) {
  const fen = chess.fen();
  const rights = fen.split(" ")[2] ?? "-";
  if (rights === "-") return "neither side may castle";
  const labels = [];
  if (rights.includes("K")) labels.push("White kingside");
  if (rights.includes("Q")) labels.push("White queenside");
  if (rights.includes("k")) labels.push("Black kingside");
  if (rights.includes("q")) labels.push("Black queenside");
  return labels.join(", ");
}

function enPassantTarget(fen) {
  const target = fen.split(" ")[3];
  return target && target !== "-" ? target : "none";
}

function availableCaptures(chess) {
  const list = chess
    .moves()
    .filter((move) => move.captured)
    .map((move) => `${move.san} (takes the ${PIECE_NAMES[move.captured]} on ${move.to})`);
  return list.slice(0, 6);
}
