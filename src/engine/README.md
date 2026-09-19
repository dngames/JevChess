# `src/engine/chess.js` — the rules engine

A complete, dependency-free chess rules implementation in one file. It exists so that
nothing about legality, move generation or game termination is ever delegated to a model:
Jev's answers are only ever *choices among moves this engine says are legal*.

## Contract

```js
import { Chess } from "./chess.js";

const chess = new Chess();                    // or new Chess(fen); throws on an invalid FEN
```

| Method | Returns |
| --- | --- |
| `new Chess(fen?)` | start position by default; throws if the FEN is invalid |
| `load(fen)` / `reset()` | reset the position |
| `fen()` | full FEN, all six fields, correct clocks |
| `turn()` | `'w'` or `'b'` |
| `board()` | **8×8 nested array** of rows, rank 8 first; each cell `null` or `{ square, type, color }` |
| `get(square)` | piece at an algebraic square, or `null` |
| `moves({ square? })` | legal moves as objects: `{ from, to, piece, color, captured, promotion, flags, san, before, after }` |
| `move(input)` | accepts a move object, `{ from, to, promotion }`, or SAN. Returns the applied move, or `null` if illegal — never throws for bad *user* input |
| `undo()` | reverts the last move and returns it |
| `history({ verbose })` | SAN strings, or move objects |
| `isCheck()` / `inCheck()` | is the side to move in check |
| `isCheckmate()`, `isStalemate()`, `isDraw()`, `isGameOver()`, `isInsufficientMaterial()`, `isThreefoldRepetition()`, `isFiftyMoveDraw()` | termination tests |
| `result()` | `null` while running, else `'1-0'`, `'0-1'` or `'1/2-1/2'` |
| `ascii()`, `squareColor(square)`, `moveNumber()`, `halfMoves()`, `pgn()` | presentation and bookkeeping |
| `perft(depth)` / `Chess.perft(fen, depth)` | node counts, for verification |

`flags` is a string built in a fixed order: capture/non-capture first (`c` or `n`), then
`b` (two-square push), `e` (en passant), `p` (promotion), `k`/`q` (castling). So a quiet
move is `n`, a capture-promotion is `cp`, and an en-passant capture is `ce`.

## Two things that bite

1. **`board()` is nested, not flat.** `board()[0]` is rank 8 as an array of eight cells.
   Code that indexes it as 64 flat cells silently reads rows as pieces; that bug shipped
   once in `src/engine/search.js` and made every move evaluate identically. Use
   `flatBoard()` from `src/jev/state.js` (it also accepts a `Chess` instance) or
   `.flat()`.
2. **The search reads the internal mailbox directly.** `_board` is a 0x88 `Int8Array(128)`
   where a piece is `type | 8` for White and `type | 16` for Black, and the square is
   `rank * 16 + file` with rank 0 = rank 8. `evaluateChess()` uses it because `board()`
   allocates 64 objects per call and dominated the search; it falls back to the public API
   if that layout ever changes.

## Guarantees and how they are checked

`tests/perft.test.mjs` runs 189 checks. The load-bearing ones are the standard perft node
counts, which between them cover castling rights and revocation, castling out of/through/
into check, en passant (including the pinned-en-passant case where the capture is illegal),
promotion of all four pieces, SAN disambiguation, and undo round-trips:

| position | depths verified | nodes |
| --- | --- | --- |
| start | 1–5 | 20, 400, 8 902, 197 281, 4 865 609 |
| Kiwipete | 1–4 | 48, 2 039, 97 862, 4 085 603 |
| position 3 | 1–5 | 14, 191, 2 812, 43 238, 674 624 |
| position 4 | 1–4 | 6, 264, 9 467, 422 333 |
| position 5 | 1–4 | 44, 1 486, 62 379, 2 103 487 |
| position 6 | 1–4 | 46, 2 079, 89 890, 3 894 594 |

All 26 values match the reference numbers exactly, and `start perft(4)` finishes in about
70 ms. Two rules of thumb if you change this file: run the perft suite before and after, and
never weaken a perft number to make a change pass — a perft mismatch means the generator is
wrong, and everything above it (the search, the shortlist, the evaluation bar) is then
measuring garbage.
