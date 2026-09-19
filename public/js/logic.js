/**
 * logic.js — pure, DOM-free helpers for the JevChess browser UI.
 *
 * Rules for this file:
 *   - no `document`, no `window`, no imports (it runs in Node for tests);
 *   - every export is total: bad / missing input yields null, 0, [] or a safe default
 *     instead of throwing.
 *
 * Board geometry convention (fixed, independent of whose turn it is):
 *   a1 = (0, 0) … h8 = (7, 7); x = file (a..h), y = rank (1..8).
 *   `GameState.board` is ordered rank 8 first, left to right a..h, i.e.
 *   `board[index]` where index = (7 - y) * 8 + x.
 */

/* ------------------------------------------------------------------ geometry */

/**
 * Convert a square name to integer file/rank coordinates.
 * @param {string} square e.g. "e4"
 * @returns {{x:number,y:number}|null} a1 -> {x:0,y:0}; null when malformed.
 */
export function squareToXY(square) {
  if (typeof square !== "string" || square.length !== 2) return null;
  if (!/^[a-h][1-8]$/.test(square)) return null;
  return { x: square.charCodeAt(0) - 97, y: square.charCodeAt(1) - 49 };
}

/**
 * Convert integer file/rank coordinates back to a square name.
 * @param {number} x file, 0..7
 * @param {number} y rank, 0..7
 * @returns {string|null} 0,0 -> "a1"; null when out of range.
 */
export function xyToSquare(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || x > 7 || y < 0 || y > 7) return null;
  return String.fromCharCode(97 + x) + String.fromCharCode(49 + y);
}

/** Index into `GameState.board` for a file/rank pair, or -1. */
export function boardIndex(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return -1;
  if (x < 0 || x > 7 || y < 0 || y > 7) return -1;
  return (7 - y) * 8 + x;
}

/** Square name for a `GameState.board` index, or null. */
export function squareAt(index) {
  if (!Number.isInteger(index) || index < 0 || index > 63) return null;
  return xyToSquare(index % 8, 7 - Math.floor(index / 8));
}

/** True when `square` is a well-formed a1..h8 name. */
export function isSquare(square) {
  return squareToXY(square) !== null;
}

/** Rank a piece is on (0..7) or -1. */
export function rankOf(square) {
  const xy = squareToXY(square);
  return xy ? xy.y : -1;
}

/** File a piece is on (0..7) or -1. */
export function fileOf(square) {
  const xy = squareToXY(square);
  return xy ? xy.x : -1;
}

/* ------------------------------------------------------------------- clocks */

/**
 * `m:ss`, or `m:ss.t` below 20 s. Values are truncated (a chess clock shows the
 * time you still have). Negative input is clamped to 0.
 * @param {number} ms
 * @returns {string}
 */
export function formatClock(ms) {
  const total = typeof ms === "number" && Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const tenths = Math.floor(total / 100) % 10;
  const seconds = Math.floor(total / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const base = `${minutes}:${String(secs).padStart(2, "0")}`;
  return total < 20000 ? `${base}.${tenths}` : base;
}

/** A finite number from `value`, or null. `null`/""/booleans are NOT numbers. */
function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Server/client clock offset. Add it to local time to obtain server time.
 * @param {number} serverTime ms epoch reported by the server
 * @param {number} localNow ms epoch from the browser
 * @returns {number} offset in ms, clamped to ±24 h against clock skew
 *   (0 when either input is unusable)
 */
export function serverTimeOffset(serverTime, localNow) {
  const s = toFinite(serverTime);
  const l = toFinite(localNow);
  if (s === null || l === null) return 0;
  return Math.max(-86400000, Math.min(86400000, s - l));
}

/**
 * Milliseconds remaining for `color`, interpolated locally from
 * `clocks.updatedAt` + the server/client offset. Returns null when there is no
 * usable clock for that colour (contract: `clocks` may be null).
 *
 * `offset = serverTime - localNow`, so the server clock reads `localNow + offset`;
 * the time consumed since `updatedAt` is therefore `localNow + offset - updatedAt`.
 */
export function clockRemaining(clocks, color, localNow, offset) {
  if (!clocks || typeof clocks !== "object") return null;
  const base = toFinite(clocks[color]);
  if (base === null) return null;
  const now = toFinite(localNow);
  const updatedAt = toFinite(clocks.updatedAt);
  const off = toFinite(offset);
  let remaining = base;
  if (now !== null && updatedAt !== null && clocks.running === color) {
    remaining = base - Math.max(0, now + (off === null ? 0 : off) - updatedAt);
  }
  return Math.max(0, remaining);
}

/** True when a clock should be flagged (red) — under 10 s. */
export function isLowClock(ms) {
  return typeof ms === "number" && Number.isFinite(ms) && ms < 10000;
}

/* ------------------------------------------------------------------ notation */

/**
 * Label for one ply: `"12."` for white, `"12…"` for black.
 * @param {number} ply 1-based
 * @param {string} san
 * @param {"w"|"b"} color
 * @returns {string}
 */
export function formatMoveLabel(ply, san, color) {
  const n = Number(ply);
  const moveNumber = Number.isFinite(n) && n > 0 ? Math.floor((n + 1) / 2) : 1;
  const suffix = color === "b" ? "\u2026" : ".";
  const text = typeof san === "string" && san.length > 0 ? san : "\u2026";
  return `${moveNumber}${suffix} ${text}`;
}

/** Move number (1-based) for a 1-based ply. */
export function moveNumberForPly(ply) {
  const n = Number(ply);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor((n + 1) / 2);
}

/**
 * Group a move history into numbered rows.
 * @param {Array} history MoveRecord[]
 * @returns {Array<{moveNumber:number, ply:number, white:object|null, black:object|null}>}
 *   `black` is null when the reply has not been played yet.
 */
export function pairMoves(history) {
  const list = Array.isArray(history) ? history : [];
  const rows = [];
  for (let i = 0; i < list.length; i += 1) {
    const record = list[i] && typeof list[i] === "object" ? list[i] : null;
    const color = record && record.color === "b" ? "b" : "w";
    const ply = record && Number.isFinite(Number(record.ply)) ? Number(record.ply) : i + 1;
    const moveNumber =
      record && Number.isFinite(Number(record.moveNumber))
        ? Number(record.moveNumber)
        : moveNumberForPly(ply);
    if (color === "b") {
      const last = rows[rows.length - 1];
      if (last && last.moveNumber === moveNumber && !last.black) {
        last.black = record;
        continue;
      }
      rows.push({ moveNumber, ply, white: null, black: record });
      continue;
    }
    rows.push({ moveNumber, ply, white: record, black: null });
  }
  return rows;
}

/* -------------------------------------------------------------- legal moves */

/** True when `move` is a usable LegalMove object. */
function isMove(move) {
  return (
    !!move &&
    typeof move === "object" &&
    typeof move.from === "string" &&
    typeof move.to === "string"
  );
}

/**
 * Everything that can legally move out of `square`.
 * @param {string} square
 * @param {Array} legalMoves LegalMove[]
 * @returns {Array<object>} [] when the square has no moves / input is bad.
 */
export function legalTargetsFrom(square, legalMoves) {
  if (!isSquare(square) || !Array.isArray(legalMoves)) return [];
  const out = [];
  for (const move of legalMoves) {
    if (isMove(move) && move.from === square) out.push(move);
  }
  return out;
}

/**
 * Does the move `from` -> `to` require a promotion choice? `legalMoves` is the
 * authoritative list, so we only report what the server actually allows.
 * @returns {boolean}
 */
export function needsPromotion(from, to, legalMoves) {
  return legalTargetsFrom(from, legalMoves).some(
    (move) => move.to === to && typeof move.promotion === "string" && move.promotion.length > 0,
  );
}

/** The available promotion piece letters for `from` -> `to`, in q/r/b/n order. */
export function promotionChoices(from, to, legalMoves) {
  const order = ["q", "r", "b", "n"];
  const found = new Set();
  for (const move of legalTargetsFrom(from, legalMoves)) {
    if (move.to === to && typeof move.promotion === "string" && move.promotion) {
      found.add(move.promotion.toLowerCase());
    }
  }
  return order.filter((p) => found.has(p));
}

/** The LegalMove object for `from` -> `to` (optionally restricted to a promotion). */
export function findMove(from, to, legalMoves, promotion) {
  if (!Array.isArray(legalMoves)) return null;
  const wantsPromotion =
    typeof promotion === "string" && promotion.length > 0 ? promotion.toLowerCase() : null;
  const candidates = legalTargetsFrom(from, legalMoves).filter((move) => move.to === to);
  if (wantsPromotion) {
    const exact = candidates.find(
      (move) =>
        typeof move.promotion === "string" && move.promotion.toLowerCase() === wantsPromotion,
    );
    return exact || null;
  }
  const quiet = candidates.find(
    (move) => typeof move.promotion !== "string" || move.promotion === null || move.promotion === "",
  );
  return quiet || candidates[0] || null;
}

/**
 * Is a legal move available that captures on `to` (used for the drag dot/ring)?
 * Treats the engine's `captured` field as authoritative, falling back to the
 * board when the field is absent.
 */
export function isCaptureTarget(to, from, legalMoves, board) {
  for (const move of legalTargetsFrom(from, legalMoves)) {
    if (move.to !== to) continue;
    if (typeof move.captured === "string" && move.captured) return true;
  }
  const xy = squareToXY(to);
  if (!xy || !Array.isArray(board)) return false;
  const index = boardIndex(xy.x, xy.y);
  return index >= 0 && !!board[index];
}

/**
 * Client-side threat map computed from `legalMoves` only.
 * A piece is "attacked" when some enemy legal move lands on its square.
 * @param {Array} legalMoves LegalMove[] for the side to move
 * @param {"w"|"b"} byColor the attacker colour
 * @returns {Array<{target:string, attackers:Array<{from:string,to:string,san:string,captured:(string|null)}>}>}
 *   sorted by target square; [] when nothing is attacked.
 */
export function attackedSquares(legalMoves, byColor) {
  if (!Array.isArray(legalMoves) || (byColor !== "w" && byColor !== "b")) return [];
  const byTarget = new Map();
  for (const move of legalMoves) {
    if (!isMove(move)) continue;
    if (typeof move.color === "string" && move.color !== byColor) continue;
    if (!isCaptureTarget(move.to, move.from, legalMoves, null)) {
      // Without a board we can only trust `captured`; the caller (server) lists
      // capture moves with `captured` set, so this is the contract-faithful test.
      if (!(typeof move.captured === "string" && move.captured)) continue;
    }
    let entry = byTarget.get(move.to);
    if (!entry) {
      entry = { target: move.to, attackers: [] };
      byTarget.set(move.to, entry);
    }
    const san = typeof move.san === "string" ? move.san : "";
    if (!entry.attackers.some((a) => a.from === move.from && a.to === move.to && a.san === san)) {
      entry.attackers.push({
        from: move.from,
        to: move.to,
        san,
        captured: typeof move.captured === "string" ? move.captured : null,
      });
    }
  }
  return [...byTarget.values()].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

/* --------------------------------------------------------------------- eval */

/**
 * Fraction of the eval bar that belongs to white, clamped away from the extreme
 * ends so the bar always shows which side is ahead.
 * @param {number} whiteWinProb 0..1
 * @returns {number} 0.02..0.98 (0.5 when unknown)
 */
export function evalBarFraction(whiteWinProb) {
  const p = typeof whiteWinProb === "number" ? whiteWinProb : NaN;
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(0.98, Math.max(0.02, p));
}

/** Material totals for both sides; kings count 0. Unknown types count 0. */
const PIECE_VALUES = Object.freeze({ p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 });

/**
 * @param {Array} board 64 cells of `Piece | null`
 * @returns {{w:number,b:number,diff:number}}
 */
export function materialCount(board) {
  const totals = { w: 0, b: 0, diff: 0 };
  if (!Array.isArray(board)) return totals;
  for (const piece of board) {
    if (!piece || typeof piece !== "object") continue;
    const value = PIECE_VALUES[String(piece.type).toLowerCase()];
    if (!Number.isFinite(value)) continue;
    if (piece.color === "w") totals.w += value;
    else if (piece.color === "b") totals.b += value;
  }
  totals.diff = totals.w - totals.b;
  return totals;
}

/** Material balance as a signed label, e.g. "+2" / "-1" / "" when level. */
export function formatMaterialDiff(board) {
  const diff = materialCount(board).diff;
  if (!diff) return "=";
  return diff > 0 ? `+${diff}` : `${diff}`;
}

/** Best-effort parse of an eval label like "+0.34" / "-1.2" / "M3" into centipawns. */
export function evalLabelToCp(label) {
  if (typeof label !== "string") return null;
  const cleaned = label.trim().replace(/^\+/, "");
  if (/^m\d+$/i.test(cleaned)) {
    const n = Number(cleaned.slice(1));
    return Number.isFinite(n) ? (cleaned.startsWith("-") ? -1 : 1) * 10000 : null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/* ------------------------------------------------------------------- pieces */

export const PIECE_GLYPHS = Object.freeze({
  p: "\u265F",
  n: "\u265E",
  b: "\u265D",
  r: "\u265C",
  q: "\u265B",
  k: "\u265A",
});

export const FILE_LETTERS = Object.freeze(["a", "b", "c", "d", "e", "f", "g", "h"]);

/** Unicode solid glyph for a piece, or "" when unknown. */
export function pieceGlyph(type) {
  return PIECE_GLYPHS[String(type || "").toLowerCase()] || "";
}

/** Human name of a piece type, e.g. "knight". */
export function pieceName(type) {
  const names = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
  return names[String(type || "").toLowerCase()] || "";
}

/* ------------------------------------------------------------------ position */

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const FEN_PLACEMENT = Object.freeze({
  p: "p",
  n: "n",
  b: "b",
  r: "r",
  q: "q",
  k: "k",
  P: "p",
  N: "n",
  B: "b",
  R: "r",
  Q: "q",
  K: "k",
});

/**
 * Expand the placement field of a FEN into `GameState.board` order
 * (rank 8 first, a..h left to right). Returns null when unusable.
 * @param {string} fen
 * @returns {Array<object|null>|null} exactly 64 cells
 */
export function parseFenPlacement(fen) {
  if (typeof fen !== "string") return null;
  const placement = fen.trim().split(/\s+/)[0];
  if (!placement) return null;
  const rows = placement.split("/");
  if (rows.length !== 8) return null;
  const cells = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const rank = 7 - rowIndex; // first FEN row is rank 8
    const rowSquares = [];
    for (const ch of rows[rowIndex]) {
      if (ch >= "1" && ch <= "8") {
        const empty = Number(ch);
        for (let i = 0; i < empty; i += 1) rowSquares.push(null);
      } else if (FEN_PLACEMENT[ch]) {
        rowSquares.push({ type: FEN_PLACEMENT[ch], color: ch === ch.toUpperCase() ? "w" : "b" });
      } else {
        return null;
      }
    }
    if (rowSquares.length !== 8) return null;
    for (let x = 0; x < 8; x += 1) {
      const piece = rowSquares[x];
      cells.push(piece ? { ...piece, square: xyToSquare(x, rank) } : null);
    }
  }
  return cells.length === 64 ? cells : null;
}

/** Square of `color`'s king on a board, or null when it cannot be found. */
export function kingSquare(board, color) {
  if (!Array.isArray(board) || (color !== "w" && color !== "b")) return null;
  for (let index = 0; index < board.length && index < 64; index += 1) {
    const piece = board[index];
    if (piece && typeof piece === "object" && piece.type === "k" && piece.color === color) {
      return squareAt(index);
    }
  }
  return null;
}

/** Board for the standard start position (fresh array every call). */
export function startingBoard() {
  const cells = parseFenPlacement(START_FEN);
  return cells || new Array(64).fill(null);
}

/** Whose turn a FEN says it is: "w", "b", or null. */
export function turnFromFen(fen) {
  if (typeof fen !== "string") return null;
  const parts = fen.trim().split(/\s+/);
  return parts[1] === "w" || parts[1] === "b" ? parts[1] : null;
}

/**
 * Replay a move history up to `ply` and return a read-only preview position.
 *
 * Deliberately board-only: it moves the piece from `from` to `to` (applying
 * promotions) and clears the source square. Special moves the UI must get right
 * are handled explicitly (castling rook, en-passant pawn). If a `MoveRecord`
 * carries a usable `fenAfter`, that FEN is returned alongside so the caller can
 * cross-check.
 *
 * @param {Array} history MoveRecord[]
 * @param {number} ply how many plies to apply (0 = start position)
 * @returns {{board:Array, lastMove:object|null, turn:"w"|"b", ply:number, fen:string|null}}
 */
export function positionPreviewFromHistory(history, ply) {
  const list = Array.isArray(history) ? history : [];
  const requested = Number(ply);
  const clamped = !Number.isFinite(requested)
    ? 0
    : Math.min(list.length, Math.max(0, Math.floor(requested)));
  const board = startingBoard();
  let lastMove = null;
  let fen = null;
  let turn = "w";

  for (let i = 0; i < clamped; i += 1) {
    const record = list[i] && typeof list[i] === "object" ? list[i] : null;
    if (!record) {
      turn = turn === "w" ? "b" : "w";
      lastMove = null;
      continue;
    }
    const from = isSquare(record.from) ? record.from : null;
    const to = isSquare(record.to) ? record.to : null;
    if (from && to) {
      const fromXY = squareToXY(from);
      const toXY = squareToXY(to);
      const fromIndex = boardIndex(fromXY.x, fromXY.y);
      const toIndex = boardIndex(toXY.x, toXY.y);
      const moved = board[fromIndex];
      const castle = typeof record.castle === "string" ? record.castle : "";
      // En passant: a diagonal pawn move onto an empty square removes the pawn behind.
      const captured = typeof record.captured === "string" ? record.captured : null;
      if (moved && moved.type === "p" && fromXY.x !== toXY.x && captured === "p" && !board[toIndex]) {
        const capXY = { x: toXY.x, y: fromXY.y };
        board[boardIndex(capXY.x, capXY.y)] = null;
      }
      // Castling: the king moves two files; bring the rook along.
      if (castle && moved && moved.type === "k") {
        const rank = fromXY.y;
        const rookFrom = castle.indexOf("k") >= 0 ? xyToSquare(7, rank) : xyToSquare(0, rank);
        const rookTo = castle.indexOf("k") >= 0 ? xyToSquare(5, rank) : xyToSquare(3, rank);
        const rf = squareToXY(rookFrom);
        const rt = squareToXY(rookTo);
        const rfIndex = boardIndex(rf.x, rf.y);
        const rtIndex = boardIndex(rt.x, rt.y);
        const rook = board[rfIndex];
        if (rook) {
          board[rtIndex] = rook;
          board[rfIndex] = null;
        }
      }
      board[toIndex] = moved
        ? { ...moved, type: record.promotion ? String(record.promotion).toLowerCase() : moved.type }
        : null;
      board[fromIndex] = null;
    }
    lastMove = { from: record.from ?? null, to: record.to ?? null, san: record.san ?? null };
    turn = record.color === "w" ? "b" : record.color === "b" ? "w" : turn === "w" ? "b" : "w";
    if (typeof record.fenAfter === "string" && record.fenAfter.trim()) fen = record.fenAfter.trim();
  }

  return { board, lastMove, turn, ply: clamped, fen };
}

/**
 * Apply a single move to a board array, returning a new board (pure).
 * Used for read-only candidate previews in the judgment panel.
 */
export function applyMoveToBoard(board, move) {
  const cells = Array.isArray(board) && board.length === 64 ? board.slice() : startingBoard();
  if (!isMove(move)) return cells;
  const fromXY = squareToXY(move.from);
  const toXY = squareToXY(move.to);
  if (!fromXY || !toXY) return cells;
  const fromIndex = boardIndex(fromXY.x, fromXY.y);
  const toIndex = boardIndex(toXY.x, toXY.y);
  const moved = cells[fromIndex];
  if (moved) {
    cells[toIndex] = {
      ...moved,
      type: typeof move.promotion === "string" && move.promotion ? move.promotion.toLowerCase() : moved.type,
      square: move.to,
    };
    cells[fromIndex] = null;
  }
  return cells;
}

/* ------------------------------------------------------------- presentation */

const DIMENSION_LABELS = Object.freeze({
  search: "Code search",
  choice: "Jev's choice",
  quality: "Quality",
  safety: "Safety",
  activity: "Activity",
  kingPressure: "King pressure",
  kingpressure: "King pressure",
  king_pressure: "King pressure",
  tactical: "Tactics",
  initiative: "Initiative",
  time: "Time",
  someNewThing: "Some new thing",
  snake_case_key: "Snake case key",
});

/** Human label for a weight/dimension key; never throws on unknown keys. */
export function dimensionLabel(key) {
  if (typeof key !== "string" || !key) return "";
  const direct = DIMENSION_LABELS[key] || DIMENSION_LABELS[key.toLowerCase()];
  if (direct) return direct;
  // Unknown key: split camelCase / snake_case, then sentence-case the result.
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Format a 0..1 value as a percentage string, e.g. 0.315 -> "32%". */
export function formatPercent(value, digits = 0) {
  const n = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n)) return "–";
  return `${(n * 100).toFixed(digits)}%`;
}

/** Compact token/usage summary, e.g. "4.2k in / 180 out". */
export function formatTokens(usage) {
  if (!usage || typeof usage !== "object") return "";
  const inTokens = Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens);
  const outTokens = Number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens);
  const parts = [];
  if (Number.isFinite(inTokens)) parts.push(`${compactNumber(inTokens)} in`);
  if (Number.isFinite(outTokens)) parts.push(`${compactNumber(outTokens)} out`);
  return parts.join(" / ");
}

/** 4210 -> "4.2k"; 999 -> "999". */
export function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "–";
  if (Math.abs(n) < 1000) return String(Math.round(n));
  return `${(n / 1000).toFixed(1)}k`;
}

/** Seconds with one decimal, for the "AI thinking" indicator. */
export function formatSeconds(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "0.0";
  return (n / 1000).toFixed(1);
}

/** Label for the side to move / a colour letter. */
export function colorName(color) {
  if (color === "w") return "White";
  if (color === "b") return "Black";
  return "—";
}

const PIECE_NAMES_LONG = Object.freeze({
  p: "Pawn",
  n: "Knight",
  b: "Bishop",
  r: "Rook",
  q: "Queen",
  k: "King",
});

/** Long piece name, e.g. "Knight". */
export function pieceNameLong(type) {
  return PIECE_NAMES_LONG[String(type || "").toLowerCase()] || "Piece";
}

/**
 * Human status sentence for the top bar.
 * Tolerates every optional field being null.
 * @returns {{text:string, tone:"normal"|"warn"|"good"|"bad"}}
 */
export function statusText(game) {
  if (!game || typeof game !== "object") return { text: "No game loaded", tone: "normal" };
  const status = game.status && typeof game.status === "object" ? game.status : {};
  const check = game.check && typeof game.check === "object" ? game.check : {};
  if (status.over) {
    const result = typeof status.result === "string" ? status.result : null;
    const reason = typeof status.reason === "string" ? status.reason : null;
    const winner =
      result === "1-0" ? "White wins" : result === "0-1" ? "Black wins" : "Draw";
    const suffix = reason ? ` — ${reason}` : "";
    return { text: `${winner}${suffix}`, tone: "good" };
  }
  const side = game.turn === "b" ? "Black" : "White";
  let text = `${side} to move`;
  if (check.inCheck) text += " — check";
  const players = game.players && typeof game.players === "object" ? game.players : null;
  const player = players && players[game.turn] ? players[game.turn] : null;
  if (player && player.kind === "jev") text += " (Jev)";
  if (Array.isArray(game.legalMoves) && game.legalMoves.length === 0) {
    text = check.inCheck ? `${side} is checkmated` : "Stalemate";
  }
  return { text, tone: check.inCheck ? "warn" : "normal" };
}

/** Result string (or "*" while unfinished) for PGN output. */
export function resultTag(game) {
  const status = game && game.status && typeof game.status === "object" ? game.status : {};
  return typeof status.result === "string" && status.result ? status.result : "*";
}

const SEVEN_TAG_ROSTER = Object.freeze({
  Event: "JevChess",
  Site: "JevChess",
  Date: "",
  Round: "-",
  White: "White",
  Black: "Black",
  Result: "*",
});

/** Two-digit zero pad. */
function pad2(n) {
  return String(Math.abs(Math.trunc(n))).padStart(2, "0");
}

/** ISO-ish PGN date (yyyy.mm.dd) from a ms epoch; "" when unusable. */
export function pgnDate(at) {
  const n = Number(at);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}.${pad2(d.getUTCMonth() + 1)}.${pad2(d.getUTCDate())}`;
}

/**
 * Build a PGN document from a `GameState` (client-side; the contract has no PGN
 * endpoint). Tolerant: unknown fields simply produce default tags, and a null or
 * unusable game still yields a valid Seven Tag Roster scaffold.
 */
export function pgnFromGame(game) {
  const source = game && typeof game === "object" ? game : {};
  const players = source.players && typeof source.players === "object" ? source.players : {};
  const whiteName = players.w && typeof players.w.name === "string" ? players.w.name : "White";
  const blackName = players.b && typeof players.b.name === "string" ? players.b.name : "Black";
  const result = resultTag(source);
  const createdAt =
    Number.isFinite(Number(source.createdAt)) && Number(source.createdAt) > 0
      ? Number(source.createdAt)
      : Date.now();
  const tags = {
    ...SEVEN_TAG_ROSTER,
    Date: pgnDate(createdAt),
    White: whiteName,
    Black: blackName,
    Result: result,
  };
  const lines = Object.entries(tags).map(([key, value]) => `[${key} "${String(value).replace(/"/g, "'")}"]`);

  const history = Array.isArray(source.history) ? source.history : [];
  const tokens = [];
  for (const row of pairMoves(history)) {
    if (row.white) tokens.push(`${row.moveNumber}. ${sanOrPlaceholder(row.white)}`);
    if (row.black) tokens.push(sanOrPlaceholder(row.black));
  }
  if (result !== "*") tokens.push(result);

  // Wrap at ~80 characters like every other PGN writer.
  const body = [];
  let line = "";
  for (const token of tokens) {
    if (!line) line = token;
    else if (line.length + 1 + token.length > 80) {
      body.push(line);
      line = token;
    } else line += ` ${token}`;
  }
  if (line) body.push(line);
  return [...lines, "", ...body].join("\n").trimEnd() + "\n";
}

function sanOrPlaceholder(record) {
  if (record && typeof record.san === "string" && record.san) return record.san;
  return "?";
}

/**
 * The MoveRecord shown in the judgment panel: the explicit selection from the
 * UI, else the newest Jev move in the history.
 */
export function latestJevRecord(history) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const record = list[i];
    if (record && record.by === "jev" && record.jev) return record;
    if (record && record.jev) return record;
  }
  return null;
}

/** A 0..1 number clamped into range, or null when the input is not a number. */
function toUnit(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

/**
 * Normalise `JevMove.candidates` into render-ready rows, sorted by composite
 * score when available (server order is preserved when it is not).
 * Never throws on partial candidate objects.
 */
export function candidateRows(jevMove) {
  if (!jevMove || typeof jevMove !== "object") return [];
  const candidates = Array.isArray(jevMove.candidates) ? jevMove.candidates : [];
  const rows = candidates.map((candidate, index) => {
    const c = candidate && typeof candidate === "object" ? candidate : {};
    const dims = c.dims && typeof c.dims === "object" ? c.dims : {};
    const dimEntries = Object.entries(dims)
      .map(([key, value]) => ({ key, label: dimensionLabel(key), value: toUnit(value) }))
      .filter((dim) => dim.value !== null);
    return {
      index,
      san: typeof c.san === "string" ? c.san : "?",
      from: typeof c.from === "string" ? c.from : null,
      to: typeof c.to === "string" ? c.to : null,
      chosen: c.chosen === true || (typeof c.san === "string" && c.san === jevMove.chosenSan),
      searchRank: Number.isFinite(Number(c.searchRank)) ? Number(c.searchRank) : null,
      searchScore: typeof c.searchScore === "number" && Number.isFinite(c.searchScore) ? c.searchScore : null,
      searchCp: typeof c.searchCp === "number" && Number.isFinite(c.searchCp) ? c.searchCp : null,
      choiceProb: toUnit(c.choiceProb),
      dims: dimEntries,
      composite: toUnit(c.composite),
      tags: Array.isArray(c.tags) ? c.tags.filter((t) => typeof t === "string") : [],
    };
  });
  const anyComposite = rows.some((row) => row.composite !== null);
  const anyRank = rows.some((row) => row.searchRank !== null);
  if (anyComposite) {
    rows.sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1));
  } else if (anyRank) {
    rows.sort((a, b) => (a.searchRank ?? 99) - (b.searchRank ?? 99));
  }
  return rows;
}

/** Weight entries in force, largest first, capped for display. */
export function weightEntries(weights) {
  if (!weights || typeof weights !== "object") return [];
  return Object.entries(weights)
    .map(([key, value]) => ({
      key,
      label: dimensionLabel(key),
      value: Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null,
    }))
    .filter((entry) => entry.value !== null)
    .sort((a, b) => b.value - a.value);
}

/** Label for the audit `noul` value; `null` is shown as "—". */
export function auditRows(audit) {
  if (!Array.isArray(audit)) return [];
  return audit.map((entry, index) => {
    const e = entry && typeof entry === "object" ? entry : {};
    return {
      index,
      question: typeof e.question === "string" ? e.question : `Question ${index + 1}`,
      noul: Number.isFinite(Number(e.noul)) ? Number(e.noul) : null,
      veto: e.veto === true,
    };
  });
}

/** A safe string for text nodes. */
export function asText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

/** Clamp helper used by sliders and bars. */
export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Number.isFinite(min) ? min : 0;
  return Math.min(max, Math.max(min, n));
}

/** Unique, stable list of the dimensions present across a JevMove's candidates. */
export function dimensionKeys(jevMove) {
  const keys = [];
  const candidates = jevMove && Array.isArray(jevMove.candidates) ? jevMove.candidates : [];
  for (const candidate of candidates) {
    const dims = candidate && candidate.dims && typeof candidate.dims === "object" ? candidate.dims : {};
    for (const key of Object.keys(dims)) if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}
