/**
 * chess.js — dependency-free chess rules engine (ES module).
 *
 * Board representation: 0x88 mailbox (Int8Array(128)).
 *   index = row * 16 + file, row 0 === rank 8, file 0 === 'a'.
 *   Therefore: sqName(i) = 'abcdefgh'[i & 15] + (8 - (i >> 4))
 *
 * Piece encoding: type bits (1..6) | colour bit (8 = white, 16 = black).
 *   0 === empty square.
 *
 * Public API (do not rename — a strategy layer and UI build on this):
 *   new Chess(fen?)            load(fen)          reset()
 *   fen()                      turn()             board()      get(square)
 *   moves({square}?)           move(input)        undo()       history({verbose}?)
 *   isCheck()/inCheck()        isCheckmate()      isStalemate()
 *   isInsufficientMaterial()   isThreefoldRepetition()        isFiftyMoveDraw()
 *   isDraw()                   isGameOver()       result()
 *   squareColor(square)        ascii()            pgn()
 *   moveNumber()               halfMoves()        perft(depth)  Chess.perft(fen, depth)
 *
 * Move object shape returned by moves() / move() / undo() / history({verbose:true}):
 *   { from, to, piece, color, captured, promotion, flags, san, before, after }
 *     from/to      algebraic squares ('e2')
 *     piece        moving piece type: 'p','n','b','r','q','k'
 *     color        'w' | 'b'
 *     captured     captured piece type, or undefined
 *     promotion    promotion piece type, or undefined
 *     flags        string built from, in this order:
 *                    'c' capture (mutually exclusive with 'n')
 *                    'n' non-capture
 *                    'b' big pawn (two-square push)
 *                    'e' en passant capture  (always paired with 'c' -> "ce")
 *                    'p' promotion
 *                    'k' kingside castle  /  'q' queenside castle
 *                  e.g. "n", "nb", "c", "ce", "cp", "np", "k", "q"
 *     san          Standard Algebraic Notation (with + / # suffix)
 *     before/after FEN strings immediately before and after the move
 *
 * Repetition note: threefold repetition is counted from the position set up by
 * the constructor or the most recent load()/reset(). Positions played before a
 * loaded FEN are unknown to the engine and therefore CANNOT contribute to a
 * repetition count.
 *
 * En passant note: fen() always reports the en-passant target square after a
 * two-square pawn push (standard FEN behaviour), but the repetition key only
 * includes it when an en-passant capture is actually available, so that two
 * otherwise-identical positions are not treated as different.
 */

const WHITE = 8;
const BLACK = 16;

const PAWN = 1;
const KNIGHT = 2;
const BISHOP = 3;
const ROOK = 4;
const QUEEN = 5;
const KING = 6;

const TYPE_CHARS = { 1: 'p', 2: 'n', 3: 'b', 4: 'r', 5: 'q', 6: 'k' };
const CHAR_TYPES = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

const PROMOTION_PIECES = ['q', 'r', 'b', 'n'];

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33];
const BISHOP_OFFSETS = [-17, -15, 15, 17];
const ROOK_OFFSETS = [-16, -1, 1, 16];
const KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17];

// Castling rights bitmask.
const C_WK = 1; // white kingside  (K)
const C_WQ = 2; // white queenside (Q)
const C_BK = 4; // black kingside  (k)
const C_BQ = 8; // black queenside (q)

// Home squares (0x88 indices).
const A8 = 0, E8 = 4, H8 = 7;
const A1 = 112, E1 = 116, H1 = 119;

const fileOf = (i) => i & 15;
const rankOf = (i) => i >> 4; // 0 === rank 8

function sqName(i) {
  return 'abcdefgh'[i & 15] + (8 - (i >> 4));
}

/** Algebraic square -> 0x88 index, or -1 when not a square. */
function sqIndex(sq) {
  if (typeof sq === 'number') {
    return Number.isInteger(sq) && sq >= 0 && sq < 128 && (sq & 0x88) === 0 ? sq : -1;
  }
  if (typeof sq !== 'string' || sq.length < 2) return -1;
  const s = sq.toLowerCase();
  const f = s.charCodeAt(0) - 97;
  const r = s.charCodeAt(1) - 49; // '1' -> 0
  if (f < 0 || f > 7 || r < 0 || r > 7) return -1;
  if (s.length > 2) return -1;
  return (7 - r) * 16 + f;
}

const typeOfCode = (c) => c & 7;
const colorOfCode = (c) => ((c & WHITE) !== 0 ? 'w' : 'b');
const codeOf = (type, color) => CHAR_TYPES[type] | (color === 'w' ? WHITE : BLACK);
const pieceChar = (c) => (colorOfCode(c) === 'w' ? TYPE_CHARS[typeOfCode(c)].toUpperCase() : TYPE_CHARS[typeOfCode(c)]);

function other(color) {
  return color === 'w' ? 'b' : 'w';
}

/**
 * Parse + validate a FEN string. Throws Error on anything invalid.
 */
function parseFen(fen) {
  if (typeof fen !== 'string') throw new Error('Invalid FEN: expected a string');
  const tokens = fen.trim().split(/\s+/);
  if (tokens.length !== 6) {
    throw new Error(`Invalid FEN: expected 6 space-delimited fields, got ${tokens.length}`);
  }
  const [placement, turn, castlingToken, epToken, halfToken, fullToken] = tokens;

  if (turn !== 'w' && turn !== 'b') throw new Error(`Invalid FEN: bad active colour '${turn}'`);

  const rows = placement.split('/');
  if (rows.length !== 8) throw new Error(`Invalid FEN: expected 8 ranks, got ${rows.length}`);

  const board = new Int8Array(128);
  let wk = -1;
  let bk = -1;

  for (let r = 0; r < 8; r++) {
    const row = rows[r];
    let f = 0;
    for (let ci = 0; ci < row.length; ci++) {
      const ch = row[ci];
      if (ch >= '1' && ch <= '8') {
        f += ch.charCodeAt(0) - 48;
        if (f > 8) throw new Error(`Invalid FEN: rank ${8 - r} has more than 8 files`);
        continue;
      }
      const type = CHAR_TYPES[ch.toLowerCase()];
      if (!type) throw new Error(`Invalid FEN: unexpected character '${ch}' in rank ${8 - r}`);
      if (f > 7) throw new Error(`Invalid FEN: rank ${8 - r} has more than 8 files`);
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      const idx = r * 16 + f;
      board[idx] = type | (color === 'w' ? WHITE : BLACK);
      if (type === KING) {
        if (color === 'w') {
          if (wk >= 0) throw new Error('Invalid FEN: more than one white king');
          wk = idx;
        } else {
          if (bk >= 0) throw new Error('Invalid FEN: more than one black king');
          bk = idx;
        }
      }
      f++;
    }
    if (f !== 8) throw new Error(`Invalid FEN: rank ${8 - r} does not have 8 files`);
  }

  if (wk < 0) throw new Error('Invalid FEN: missing white king');
  if (bk < 0) throw new Error('Invalid FEN: missing black king');

  let castling = 0;
  if (castlingToken !== '-') {
    if (!/^K?Q?k?q?$/.test(castlingToken)) {
      throw new Error(`Invalid FEN: bad castling field '${castlingToken}'`);
    }
    if (castlingToken.includes('K')) castling |= C_WK;
    if (castlingToken.includes('Q')) castling |= C_WQ;
    if (castlingToken.includes('k')) castling |= C_BK;
    if (castlingToken.includes('q')) castling |= C_BQ;
  }

  let ep = -1;
  if (epToken !== '-') {
    if (!/^[a-h][1-8]$/.test(epToken)) throw new Error(`Invalid FEN: bad en passant square '${epToken}'`);
    if (turn === 'w' && epToken[1] !== '6') {
      throw new Error('Invalid FEN: en passant square must be on rank 6 when white is to move');
    }
    if (turn === 'b' && epToken[1] !== '3') {
      throw new Error('Invalid FEN: en passant square must be on rank 3 when black is to move');
    }
    ep = sqIndex(epToken);
  }

  if (!/^\d+$/.test(halfToken)) throw new Error(`Invalid FEN: bad halfmove clock '${halfToken}'`);
  if (!/^\d+$/.test(fullToken)) throw new Error(`Invalid FEN: bad fullmove number '${fullToken}'`);
  const halfMoves = parseInt(halfToken, 10);
  const fullMoves = parseInt(fullToken, 10);
  if (fullMoves < 1) throw new Error('Invalid FEN: fullmove number must be >= 1');

  return { board, turn, castling, ep, halfMoves, fullMoves, wk, bk };
}

export class Chess {
  constructor(fen) {
    this._board = new Int8Array(128);
    this._turn = 'w';
    this._castling = 0;
    this._ep = -1;
    this._halfMoves = 0;
    this._fullMoves = 1;
    this._kingSq = { w: -1, b: -1 };
    this._undoStack = [];
    this._history = [];
    this._positionCounts = new Map();
    this._initialFen = START_FEN;
    this.load(fen === undefined || fen === null ? START_FEN : fen);
  }

  /* ------------------------------------------------------------------ *
   *  Position setup
   * ------------------------------------------------------------------ */

  /** Reset to the standard starting position. */
  reset() {
    return this.load(START_FEN);
  }

  /** Load a FEN. Throws on an invalid FEN; state is left untouched when it throws. */
  load(fen) {
    const parsed = parseFen(fen);
    this._board = parsed.board;
    this._turn = parsed.turn;
    this._castling = parsed.castling;
    this._ep = parsed.ep;
    this._halfMoves = parsed.halfMoves;
    this._fullMoves = parsed.fullMoves;
    this._kingSq = { w: parsed.wk, b: parsed.bk };
    this._undoStack = [];
    this._history = [];
    this._positionCounts = new Map();
    this._initialFen = this.fen();
    this._incPosition();
    return this;
  }

  /* ------------------------------------------------------------------ *
   *  Basic accessors
   * ------------------------------------------------------------------ */

  /** Current FEN, all six fields. */
  fen() {
    let placement = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const c = this._board[r * 16 + f];
        if (c === 0) {
          empty++;
        } else {
          if (empty > 0) {
            placement += empty;
            empty = 0;
          }
          placement += pieceChar(c);
        }
      }
      if (empty > 0) placement += empty;
      if (r < 7) placement += '/';
    }
    const ep = this._ep >= 0 ? sqName(this._ep) : '-';
    return `${placement} ${this._turn} ${this._castlingString()} ${ep} ${this._halfMoves} ${this._fullMoves}`;
  }

  _castlingString() {
    let s = '';
    if (this._castling & C_WK) s += 'K';
    if (this._castling & C_WQ) s += 'Q';
    if (this._castling & C_BK) s += 'k';
    if (this._castling & C_BQ) s += 'q';
    return s === '' ? '-' : s;
  }

  turn() {
    return this._turn;
  }

  moveNumber() {
    return this._fullMoves;
  }

  halfMoves() {
    return this._halfMoves;
  }

  /** 8x8 array, rank 8 first. Empty cells are null. */
  board() {
    const out = [];
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let f = 0; f < 8; f++) {
        const i = r * 16 + f;
        const c = this._board[i];
        row.push(c === 0 ? null : { square: sqName(i), type: TYPE_CHARS[typeOfCode(c)], color: colorOfCode(c) });
      }
      out.push(row);
    }
    return out;
  }

  /** Piece at an algebraic square, or null. */
  get(square) {
    const i = sqIndex(square);
    if (i < 0) return null;
    const c = this._board[i];
    if (c === 0) return null;
    return { square: sqName(i), type: TYPE_CHARS[typeOfCode(c)], color: colorOfCode(c) };
  }

  /** 'light', 'dark', or null for an invalid square. */
  squareColor(square) {
    const i = sqIndex(square);
    if (i < 0) return null;
    return (fileOf(i) + (8 - rankOf(i))) % 2 === 0 ? 'light' : 'dark';
  }

  ascii() {
    let s = '   +------------------------+\n';
    for (let r = 0; r < 8; r++) {
      s += ` ${8 - r} |`;
      for (let f = 0; f < 8; f++) {
        const c = this._board[r * 16 + f];
        s += ` ${c === 0 ? '.' : pieceChar(c)} `;
      }
      s += '|\n';
    }
    s += '   +------------------------+\n';
    s += '     a  b  c  d  e  f  g  h';
    return s;
  }

  /* ------------------------------------------------------------------ *
   *  Attack / check detection
   * ------------------------------------------------------------------ */

  /** Is `sq` attacked by colour `by` ('w' | 'b')? */
  _isAttacked(sq, by) {
    const board = this._board;

    // Pawns. A white pawn on p attacks p-15 and p-17, so a white pawn
    // attacking `sq` sits on sq+15 or sq+17 (mirrored for black).
    if (by === 'w') {
      let s = sq + 15;
      if ((s & 0x88) === 0 && board[s] === (PAWN | WHITE)) return true;
      s = sq + 17;
      if ((s & 0x88) === 0 && board[s] === (PAWN | WHITE)) return true;
    } else {
      let s = sq - 15;
      if ((s & 0x88) === 0 && board[s] === (PAWN | BLACK)) return true;
      s = sq - 17;
      if ((s & 0x88) === 0 && board[s] === (PAWN | BLACK)) return true;
    }

    // Knights.
    const knight = KNIGHT | (by === 'w' ? WHITE : BLACK);
    for (let k = 0; k < 8; k++) {
      const s = sq + KNIGHT_OFFSETS[k];
      if ((s & 0x88) === 0 && board[s] === knight) return true;
    }

    // King.
    const king = KING | (by === 'w' ? WHITE : BLACK);
    for (let k = 0; k < 8; k++) {
      const s = sq + KING_OFFSETS[k];
      if ((s & 0x88) === 0 && board[s] === king) return true;
    }

    // Rooks / queens.
    const rook = ROOK | (by === 'w' ? WHITE : BLACK);
    const queen = QUEEN | (by === 'w' ? WHITE : BLACK);
    for (let k = 0; k < 4; k++) {
      const off = ROOK_OFFSETS[k];
      let s = sq + off;
      while ((s & 0x88) === 0) {
        const c = board[s];
        if (c !== 0) {
          if (c === rook || c === queen) return true;
          break;
        }
        s += off;
      }
    }

    // Bishops / queens.
    const bishop = BISHOP | (by === 'w' ? WHITE : BLACK);
    for (let k = 0; k < 4; k++) {
      const off = BISHOP_OFFSETS[k];
      let s = sq + off;
      while ((s & 0x88) === 0) {
        const c = board[s];
        if (c !== 0) {
          if (c === bishop || c === queen) return true;
          break;
        }
        s += off;
      }
    }

    return false;
  }

  _inCheck(color) {
    const k = this._kingSq[color];
    if (k < 0) return false;
    return this._isAttacked(k, other(color));
  }

  isCheck() {
    return this._inCheck(this._turn);
  }

  inCheck() {
    return this._inCheck(this._turn);
  }

  /* ------------------------------------------------------------------ *
   *  Move generation
   * ------------------------------------------------------------------ */

  /** Pseudo-legal moves for `us` (optionally only from one 0x88 index). */
  _generateMoves(us, onlyFrom = -1) {
    const moves = [];
    const board = this._board;
    const forward = us === 'w' ? -16 : 16;
    const startRow = us === 'w' ? 6 : 1;
    const promoRow = us === 'w' ? 0 : 7;

    const start = onlyFrom >= 0 ? onlyFrom : 0;
    const end = onlyFrom >= 0 ? onlyFrom + 1 : 128;

    for (let i = start; i < end; i++) {
      if ((i & 0x88) !== 0) continue;
      const code = board[i];
      if (code === 0) continue;
      if (colorOfCode(code) !== us) continue;
      const t = typeOfCode(code);

      if (t === PAWN) {
        // Single push.
        const one = i + forward;
        if ((one & 0x88) === 0 && board[one] === 0) {
          if (rankOf(one) === promoRow) {
            for (let k = 0; k < 4; k++) {
              moves.push({ from: i, to: one, piece: 'p', color: us, captured: undefined, promotion: PROMOTION_PIECES[k], flags: 'np' });
            }
          } else {
            moves.push({ from: i, to: one, piece: 'p', color: us, captured: undefined, promotion: undefined, flags: 'n' });
            if (rankOf(i) === startRow) {
              const two = i + forward * 2;
              if (board[two] === 0) {
                moves.push({ from: i, to: two, piece: 'p', color: us, captured: undefined, promotion: undefined, flags: 'nb' });
              }
            }
          }
        }

        // Diagonal captures (and en passant).
        for (let d = -1; d <= 1; d += 2) {
          const to = i + forward + d;
          if ((to & 0x88) !== 0) continue;
          const target = board[to];
          if (target !== 0) {
            if (colorOfCode(target) === us) continue;
            const captured = TYPE_CHARS[typeOfCode(target)];
            if (rankOf(to) === promoRow) {
              for (let k = 0; k < 4; k++) {
                moves.push({ from: i, to, piece: 'p', color: us, captured, promotion: PROMOTION_PIECES[k], flags: 'cp' });
              }
            } else {
              moves.push({ from: i, to, piece: 'p', color: us, captured, promotion: undefined, flags: 'c' });
            }
          } else if (to === this._ep) {
            const capSq = us === 'w' ? to + 16 : to - 16;
            if (board[capSq] === (PAWN | (us === 'w' ? BLACK : WHITE))) {
              moves.push({ from: i, to, piece: 'p', color: us, captured: 'p', promotion: undefined, flags: 'ce' });
            }
          }
        }
      } else if (t === KNIGHT || t === KING) {
        const offs = t === KNIGHT ? KNIGHT_OFFSETS : KING_OFFSETS;
        const piece = TYPE_CHARS[t];
        for (let k = 0; k < 8; k++) {
          const to = i + offs[k];
          if ((to & 0x88) !== 0) continue;
          const target = board[to];
          if (target === 0) {
            moves.push({ from: i, to, piece, color: us, captured: undefined, promotion: undefined, flags: 'n' });
          } else if (colorOfCode(target) !== us) {
            moves.push({ from: i, to, piece, color: us, captured: TYPE_CHARS[typeOfCode(target)], promotion: undefined, flags: 'c' });
          }
        }
      } else {
        const dirs = t === BISHOP ? BISHOP_OFFSETS : t === ROOK ? ROOK_OFFSETS : KING_OFFSETS;
        const n = t === QUEEN ? 8 : 4;
        const piece = TYPE_CHARS[t];
        for (let k = 0; k < n; k++) {
          const off = dirs[k];
          let to = i + off;
          while ((to & 0x88) === 0) {
            const target = board[to];
            if (target === 0) {
              moves.push({ from: i, to, piece, color: us, captured: undefined, promotion: undefined, flags: 'n' });
            } else {
              if (colorOfCode(target) !== us) {
                moves.push({ from: i, to, piece, color: us, captured: TYPE_CHARS[typeOfCode(target)], promotion: undefined, flags: 'c' });
              }
              break;
            }
            to += off;
          }
        }
      }
    }

    // Castling.
    const them = other(us);
    const ks = us === 'w' ? E1 : E8;
    if ((onlyFrom < 0 || onlyFrom === ks) && board[ks] === (KING | (us === 'w' ? WHITE : BLACK))) {
      const rookCode = ROOK | (us === 'w' ? WHITE : BLACK);
      // Kingside: king e->g, rook h->f. e, f, g must be empty and unattacked.
      const hRook = us === 'w' ? H1 : H8;
      const fSq = us === 'w' ? 117 : 5;
      const gSq = us === 'w' ? 118 : 6;
      const kRight = us === 'w' ? C_WK : C_BK;
      if ((this._castling & kRight) && board[hRook] === rookCode && board[fSq] === 0 && board[gSq] === 0) {
        if (!this._isAttacked(ks, them) && !this._isAttacked(fSq, them) && !this._isAttacked(gSq, them)) {
          moves.push({ from: ks, to: gSq, piece: 'k', color: us, captured: undefined, promotion: undefined, flags: 'k' });
        }
      }
      // Queenside: king e->c, rook a->d. b, c, d must be empty; e, d, c unattacked.
      const aRook = us === 'w' ? A1 : A8;
      const bSq = us === 'w' ? 113 : 1;
      const cSq = us === 'w' ? 114 : 2;
      const dSq = us === 'w' ? 115 : 3;
      const qRight = us === 'w' ? C_WQ : C_BQ;
      if ((this._castling & qRight) && board[aRook] === rookCode && board[bSq] === 0 && board[cSq] === 0 && board[dSq] === 0) {
        if (!this._isAttacked(ks, them) && !this._isAttacked(dSq, them) && !this._isAttacked(cSq, them)) {
          moves.push({ from: ks, to: cSq, piece: 'k', color: us, captured: undefined, promotion: undefined, flags: 'q' });
        }
      }
    }

    return moves;
  }

  /** Fully legal moves for `us` (optionally only from one 0x88 index). */
  _generateLegalMoves(us, onlyFrom = -1) {
    const pseudo = this._generateMoves(us, onlyFrom);
    const legal = [];
    const them = other(us);
    for (let i = 0; i < pseudo.length; i++) {
      const m = pseudo[i];
      this._makeMove(m, false);
      if (!this._isAttacked(this._kingSq[us], them)) legal.push(m);
      this._unmakeMove();
    }
    return legal;
  }

  /* ------------------------------------------------------------------ *
   *  Make / unmake
   * ------------------------------------------------------------------ */

  _makeMove(move, track) {
    const board = this._board;
    const us = move.color;
    const them = other(us);
    const from = move.from;
    const to = move.to;
    const pieceCode = board[from];
    const isEp = move.flags.indexOf('e') >= 0;

    let capturedCode = 0;
    let epCaptureSq = -1;
    if (isEp) {
      epCaptureSq = us === 'w' ? to + 16 : to - 16;
      capturedCode = board[epCaptureSq];
      board[epCaptureSq] = 0;
    } else if (board[to] !== 0) {
      capturedCode = board[to];
    }

    const entry = {
      move,
      from,
      to,
      pieceCode,
      capturedCode,
      epCaptureSq,
      castling: this._castling,
      ep: this._ep,
      halfMoves: this._halfMoves,
      fullMoves: this._fullMoves,
      kw: this._kingSq.w,
      kb: this._kingSq.b,
      tracked: !!track,
    };

    board[from] = 0;
    board[to] = move.promotion ? codeOf(move.promotion, us) : pieceCode;

    const t = typeOfCode(pieceCode);
    if (t === KING) {
      this._kingSq[us] = to;
      this._castling &= us === 'w' ? ~(C_WK | C_WQ) : ~(C_BK | C_BQ);
    } else if (t === ROOK) {
      if (from === H1) this._castling &= ~C_WK;
      else if (from === A1) this._castling &= ~C_WQ;
      else if (from === H8) this._castling &= ~C_BK;
      else if (from === A8) this._castling &= ~C_BQ;
    }

    // A rook captured on its home square also revokes the corresponding right.
    if (capturedCode !== 0 && typeOfCode(capturedCode) === ROOK) {
      if (to === H1) this._castling &= ~C_WK;
      else if (to === A1) this._castling &= ~C_WQ;
      else if (to === H8) this._castling &= ~C_BK;
      else if (to === A8) this._castling &= ~C_BQ;
    }

    // Relocate the rook on castling.
    if (move.flags.indexOf('k') >= 0) {
      board[to + 1] = 0;
      board[to - 1] = ROOK | (us === 'w' ? WHITE : BLACK);
    } else if (move.flags.indexOf('q') >= 0) {
      board[to - 2] = 0;
      board[to + 1] = ROOK | (us === 'w' ? WHITE : BLACK);
    }

    if (t === PAWN && Math.abs(to - from) === 32) {
      this._ep = from + (us === 'w' ? -16 : 16);
    } else {
      this._ep = -1;
    }

    if (t === PAWN || capturedCode !== 0) this._halfMoves = 0;
    else this._halfMoves++;
    if (us === 'b') this._fullMoves++;
    this._turn = them;

    this._undoStack.push(entry);
    if (track) this._incPosition();
    return entry;
  }

  _unmakeMove() {
    if (this._undoStack.length === 0) return null;
    const entry = this._undoStack.pop();
    if (entry.tracked) this._decPosition(); // key of the position the move created

    const board = this._board;
    const move = entry.move;
    const us = move.color;

    this._turn = us;
    this._castling = entry.castling;
    this._ep = entry.ep;
    this._halfMoves = entry.halfMoves;
    this._fullMoves = entry.fullMoves;
    this._kingSq.w = entry.kw;
    this._kingSq.b = entry.kb;

    board[entry.from] = entry.pieceCode;
    board[entry.to] = 0;
    if (entry.capturedCode !== 0) {
      if (entry.epCaptureSq >= 0) board[entry.epCaptureSq] = entry.capturedCode;
      else board[entry.to] = entry.capturedCode;
    }

    if (move.flags.indexOf('k') >= 0) {
      board[entry.to - 1] = 0;
      board[entry.to + 1] = ROOK | (us === 'w' ? WHITE : BLACK);
    } else if (move.flags.indexOf('q') >= 0) {
      board[entry.to + 1] = 0;
      board[entry.to - 2] = ROOK | (us === 'w' ? WHITE : BLACK);
    }

    return entry;
  }

  /* ------------------------------------------------------------------ *
   *  Repetition bookkeeping
   * ------------------------------------------------------------------ */

  /** True when the side to move can actually capture en passant. */
  _epCaptureAvailable() {
    if (this._ep < 0) return false;
    const us = this._turn;
    const pawn = PAWN | (us === 'w' ? WHITE : BLACK);
    const cands = us === 'w' ? [this._ep + 15, this._ep + 17] : [this._ep - 15, this._ep - 17];
    for (let k = 0; k < 2; k++) {
      const s = cands[k];
      if ((s & 0x88) === 0 && this._board[s] === pawn) return true;
    }
    return false;
  }

  _positionKey() {
    let s = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const c = this._board[r * 16 + f];
        if (c === 0) {
          empty++;
          continue;
        }
        if (empty > 0) {
          s += empty;
          empty = 0;
        }
        s += pieceChar(c);
      }
      if (empty > 0) s += empty;
      if (r < 7) s += '/';
    }
    const ep = this._epCaptureAvailable() ? sqName(this._ep) : '-';
    return `${s} ${this._turn} ${this._castlingString()} ${ep}`;
  }

  _incPosition() {
    const k = this._positionKey();
    this._positionCounts.set(k, (this._positionCounts.get(k) || 0) + 1);
  }

  _decPosition() {
    const k = this._positionKey();
    const n = (this._positionCounts.get(k) || 0) - 1;
    if (n <= 0) this._positionCounts.delete(k);
    else this._positionCounts.set(k, n);
  }

  /* ------------------------------------------------------------------ *
   *  SAN
   * ------------------------------------------------------------------ */

  _sanBase(m, legal) {
    if (m.flags.indexOf('k') >= 0) return 'O-O';
    if (m.flags.indexOf('q') >= 0) return 'O-O-O';

    const fromFile = 'abcdefgh'[fileOf(m.from)];
    const to = sqName(m.to);

    if (m.piece === 'p') {
      let san = m.captured !== undefined ? `${fromFile}x` : '';
      san += to;
      if (m.promotion) san += `=${m.promotion.toUpperCase()}`;
      return san;
    }

    let san = m.piece.toUpperCase();
    let others = null;
    for (let i = 0; i < legal.length; i++) {
      const o = legal[i];
      // Compare by fields, not identity: `m` may come from a different (but
      // equivalent) move-generation pass than the `legal` list passed in.
      if (o.from === m.from && o.to === m.to && o.promotion === m.promotion) continue;
      if (o.piece !== m.piece || o.to !== m.to) continue;
      if (others === null) others = [];
      others.push(o);
    }
    if (others !== null) {
      const sameFile = others.some((o) => fileOf(o.from) === fileOf(m.from));
      const sameRank = others.some((o) => rankOf(o.from) === rankOf(m.from));
      if (!sameFile) san += fromFile;
      else if (!sameRank) san += String(8 - rankOf(m.from));
      else san += sqName(m.from);
    }
    if (m.captured !== undefined) san += 'x';
    san += to;
    return san;
  }

  /** '+' or '#' suffix for the move `m` (makes/unmakes it). */
  _checkSuffix(m) {
    this._makeMove(m, false);
    let suffix = '';
    if (this._inCheck(this._turn)) {
      suffix = this._generateLegalMoves(this._turn).length === 0 ? '#' : '+';
    }
    this._unmakeMove();
    return suffix;
  }

  _decorateMove(m, legal, before) {
    const san = this._sanBase(m, legal) + this._checkSuffix(m);
    this._makeMove(m, false);
    const after = this.fen();
    this._unmakeMove();
    return {
      from: sqName(m.from),
      to: sqName(m.to),
      piece: m.piece,
      color: m.color,
      captured: m.captured,
      promotion: m.promotion,
      flags: m.flags,
      san,
      before,
      after,
    };
  }

  /* ------------------------------------------------------------------ *
   *  Public move API
   * ------------------------------------------------------------------ */

  /** Legal moves (for the side to move), optionally only from one square. */
  moves(options) {
    const us = this._turn;
    let onlyFrom = -1;
    if (options && options.square !== undefined && options.square !== null) {
      onlyFrom = sqIndex(options.square);
      if (onlyFrom < 0) return [];
    }
    const legal = this._generateLegalMoves(us, onlyFrom);
    const before = this.fen();
    return legal.map((m) => this._decorateMove(m, legal, before));
  }

  _findMoveObject(input, legal) {
    if (input === null || typeof input !== 'object') return null;
    const from = sqIndex(input.from);
    const to = sqIndex(input.to);
    if (from < 0 || to < 0) return null;

    const candidates = legal.filter((m) => m.from === from && m.to === to);
    if (candidates.length === 0) return null;

    let promotions = null;
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].promotion) {
        if (promotions === null) promotions = [];
        promotions.push(candidates[i]);
      }
    }
    if (promotions === null) return candidates[0];
    const want = input.promotion === undefined || input.promotion === null ? 'q' : String(input.promotion).toLowerCase();
    for (let i = 0; i < promotions.length; i++) {
      if (promotions[i].promotion === want) return promotions[i];
    }
    return null;
  }

  _findSan(str, legal) {
    const raw = String(str).trim();
    if (raw === '') return null;

    const normalise = (s) => s.replace(/[+#!?]+/g, '').replace(/=/g, '').replace(/0/g, 'O');
    const wanted = normalise(raw);

    const sans = new Array(legal.length);
    for (let i = 0; i < legal.length; i++) {
      sans[i] = this._sanBase(legal[i], legal) + this._checkSuffix(legal[i]);
    }
    for (let i = 0; i < legal.length; i++) {
      if (normalise(sans[i]) === wanted) return legal[i];
    }
    // Case-insensitive second pass ("nf3", "o-o").
    const wantedLower = wanted.toLowerCase();
    for (let i = 0; i < legal.length; i++) {
      if (normalise(sans[i]).toLowerCase() === wantedLower) return legal[i];
    }

    // Loose coordinate notation: e2e4, e7e8q, e1g1.
    const coord = /^([a-h][1-8])([a-h][1-8])([qrbnQRBN])?$/.exec(raw.replace(/[+#!?]+/g, ''));
    if (coord) {
      const m = this._findMoveObject({ from: coord[1], to: coord[2], promotion: coord[3] }, legal);
      if (m) return m;
    }
    return null;
  }

  /** Apply a move. Returns the applied move object, or null when illegal/unparseable. */
  move(input) {
    const legal = this._generateLegalMoves(this._turn);
    let m = null;
    if (typeof input === 'string') m = this._findSan(input, legal);
    else if (input && typeof input === 'object') m = this._findMoveObject(input, legal);
    if (!m) return null;

    const before = this.fen();
    const san = this._sanBase(m, legal) + this._checkSuffix(m);

    this._makeMove(m, true);
    const after = this.fen();

    const decorated = {
      from: sqName(m.from),
      to: sqName(m.to),
      piece: m.piece,
      color: m.color,
      captured: m.captured,
      promotion: m.promotion,
      flags: m.flags,
      san,
      before,
      after,
    };
    this._history.push(decorated);
    return decorated;
  }

  /** Revert the last move and return it, or null when there is nothing to undo. */
  undo() {
    if (this._undoStack.length === 0) return null;
    this._unmakeMove();
    return this._history.length > 0 ? this._history.pop() : null;
  }

  /** SAN strings, or full move objects when `verbose` is true. */
  history(options) {
    if (options && options.verbose) return this._history.slice();
    return this._history.map((m) => m.san);
  }

  /* ------------------------------------------------------------------ *
   *  Game state queries
   * ------------------------------------------------------------------ */

  isCheckmate() {
    if (!this._inCheck(this._turn)) return false;
    return this._generateLegalMoves(this._turn).length === 0;
  }

  isStalemate() {
    if (this._inCheck(this._turn)) return false;
    return this._generateLegalMoves(this._turn).length === 0;
  }

  isInsufficientMaterial() {
    const counts = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
    const bishopColors = [];
    let total = 0;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const c = this._board[r * 16 + f];
        if (c === 0) continue;
        const t = typeOfCode(c);
        counts[TYPE_CHARS[t]]++;
        total++;
        if (t === BISHOP) bishopColors.push((f + (8 - r)) % 2 === 0 ? 'light' : 'dark');
      }
    }
    if (total === 2) return true; // K vs K
    if (total === 3 && (counts.b === 1 || counts.n === 1)) return true; // K+minor vs K
    if (counts.p === 0 && counts.r === 0 && counts.q === 0 && counts.n === 0 && counts.b > 0) {
      // Only kings and bishops: a mate is impossible when every bishop is
      // confined to squares of one colour.
      const first = bishopColors[0];
      return bishopColors.every((c) => c === first);
    }
    return false;
  }

  isThreefoldRepetition() {
    for (const n of this._positionCounts.values()) {
      if (n >= 3) return true;
    }
    return false;
  }

  isFiftyMoveDraw() {
    return this._halfMoves >= 100;
  }

  isDraw() {
    return this.isStalemate() || this.isInsufficientMaterial() || this.isFiftyMoveDraw() || this.isThreefoldRepetition();
  }

  isGameOver() {
    return this.isCheckmate() || this.isDraw();
  }

  /** null while running, else '1-0', '0-1' or '1/2-1/2'. */
  result() {
    if (this.isCheckmate()) return this._turn === 'w' ? '0-1' : '1-0';
    if (this.isDraw()) return '1/2-1/2';
    return null;
  }

  /* ------------------------------------------------------------------ *
   *  PGN
   * ------------------------------------------------------------------ */

  pgn() {
    const parts = this._initialFen.split(' ');
    const initialTurn = parts[1];
    let moveNo = parseInt(parts[5], 10);
    if (!Number.isFinite(moveNo) || moveNo < 1) moveNo = 1;

    const result = this.result() || '*';

    const lines = [];
    lines.push('[Event "?"]');
    lines.push('[Site "?"]');
    lines.push('[Date "????.??.??"]');
    lines.push('[Round "?"]');
    lines.push('[White "?"]');
    lines.push('[Black "?"]');
    if (this._initialFen !== START_FEN) {
      lines.push('[SetUp "1"]');
      lines.push(`[FEN "${this._initialFen}"]`);
    }
    lines.push(`[Result "${result}"]`);

    const tokens = [];
    let turn = initialTurn;
    let first = true;
    for (let i = 0; i < this._history.length; i++) {
      const san = this._history[i].san;
      if (turn === 'w') {
        tokens.push(`${moveNo}. ${san}`);
        turn = 'b';
      } else {
        tokens.push(first ? `${moveNo}... ${san}` : san);
        moveNo++;
        turn = 'w';
      }
      first = false;
    }
    if (tokens.length > 0) tokens.push(result);

    const movetext = tokens.join(' ');
    return lines.join('\n') + (movetext ? '\n\n' + movetext : '') + '\n';
  }

  /* ------------------------------------------------------------------ *
   *  Perft
   * ------------------------------------------------------------------ */

  /** Count leaf nodes to `depth` from the current position. */
  perft(depth) {
    const d = Number(depth);
    if (!Number.isFinite(d) || d < 0) return 0;
    return this._perft(d);
  }

  _perft(depth) {
    if (depth <= 0) return 1;
    const moves = this._generateLegalMoves(this._turn);
    if (depth === 1) return moves.length;
    let nodes = 0;
    for (let i = 0; i < moves.length; i++) {
      this._makeMove(moves[i], false);
      nodes += this._perft(depth - 1);
      this._unmakeMove();
    }
    return nodes;
  }

  /** Per-root-move node counts (debugging aid). */
  perftDivide(depth) {
    const out = {};
    if (depth <= 0) return out;
    const legal = this._generateLegalMoves(this._turn);
    const before = this.fen();
    for (let i = 0; i < legal.length; i++) {
      const m = legal[i];
      const san = this._sanBase(m, legal) + this._checkSuffix(m);
      this._makeMove(m, false);
      out[san] = depth === 1 ? 1 : this._perft(depth - 1);
      this._unmakeMove();
    }
    if (this.fen() !== before) throw new Error('perftDivide: position corrupted');
    return out;
  }

  static perft(fen, depth) {
    return new Chess(fen).perft(depth);
  }
}

export default Chess;
