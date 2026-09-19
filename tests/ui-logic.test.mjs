/**
 * ui-logic.test.mjs — Node tests for `public/js/logic.js`.
 *
 * Run with:  node tests/ui-logic.test.mjs
 *
 * The point of these tests is that the pure UI helpers are total (they never
 * throw on bad or missing input) and that the board/clock/notation maths is
 * exactly the contract's maths. No DOM, no server, no network.
 */

import assert from "node:assert/strict";
import {
  attackedSquares,
  applyMoveToBoard,
  asText,
  auditRows,
  boardIndex,
  candidateRows,
  clamp,
  clockRemaining,
  colorName,
  compactNumber,
  dimensionKeys,
  dimensionLabel,
  evalBarFraction,
  evalLabelToCp,
  fileOf,
  findMove,
  formatClock,
  formatMaterialDiff,
  formatMoveLabel,
  formatPercent,
  formatSeconds,
  formatTokens,
  isCaptureTarget,
  isLowClock,
  isSquare,
  kingSquare,
  latestJevRecord,
  legalTargetsFrom,
  materialCount,
  moveNumberForPly,
  needsPromotion,
  pairMoves,
  parseFenPlacement,
  pgnFromGame,
  pieceGlyph,
  pieceName,
  positionPreviewFromHistory,
  promotionChoices,
  rankOf,
  serverTimeOffset,
  squareAt,
  squareToXY,
  startingBoard,
  statusText,
  turnFromFen,
  weightEntries,
  xyToSquare,
} from "../public/js/logic.js";

/* --------------------------------------------------------------- harness */

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

function done() {
  const total = passed + failures.length;
  if (failures.length === 0) {
    console.log(`ui-logic: ${passed}/${total} tests passed.`);
    process.exit(0);
  }
  console.error(`ui-logic: ${failures.length} of ${total} tests FAILED.`);
  for (const { name, error } of failures) {
    console.error(`\n  x ${name}`);
    const detail = error && error.message ? error.message : String(error);
    console.error(detail.split("\n").map((line) => `    ${line}`).join("\n"));
  }
  console.error("");
  process.exit(1);
}

/* ------------------------------------------------------ synthetic fixtures */

/** A legal-move entry in the contract's shape. */
function move(from, to, extra = {}) {
  return {
    from,
    to,
    san: extra.san || `${from}${to}`,
    promotion: extra.promotion === undefined ? null : extra.promotion,
    captured: extra.captured === undefined ? null : extra.captured,
    flags: extra.flags || "",
  };
}

/** Minimal MoveRecord. */
function record(ply, color, san, from, to, extra = {}) {
  return {
    ply,
    moveNumber: Math.floor((ply + 1) / 2),
    color,
    san,
    from,
    to,
    capture: extra.capture === undefined ? null : extra.capture,
    check: extra.check === true,
    mate: extra.mate === true,
    promotion: extra.promotion === undefined ? null : extra.promotion,
    castle: extra.castle === undefined ? null : extra.castle,
    fenAfter: extra.fenAfter === undefined ? null : extra.fenAfter,
    at: 1730000000000 + ply * 1000,
    clockMs: 300000 - ply * 1000,
    by: extra.by || (color === "w" ? "human" : "jev"),
    jev: extra.jev === undefined ? null : extra.jev,
  };
}

/** Board cell helper. */
function piece(square, type, color) {
  return { square, type, color };
}

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/* ------------------------------------------------------------- geometry */

test("squareToXY: a1 is file 0 rank 0 and h8 is file 7 rank 7", () => {
  assert.deepEqual(squareToXY("a1"), { x: 0, y: 0 });
  assert.deepEqual(squareToXY("h8"), { x: 7, y: 7 });
  assert.deepEqual(squareToXY("e4"), { x: 4, y: 3 });
  assert.deepEqual(squareToXY("a8"), { x: 0, y: 7 });
  assert.deepEqual(squareToXY("h1"), { x: 7, y: 0 });
});

test("squareToXY: rejects malformed and out-of-range input without throwing", () => {
  for (const bad of ["", "a", "a0", "a9", "i1", "e4x", "44", null, undefined, 42, {}, []]) {
    assert.equal(squareToXY(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("xyToSquare: round-trips every square", () => {
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const square = xyToSquare(x, y);
      assert.equal(typeof square, "string");
      assert.deepEqual(squareToXY(square), { x, y });
    }
  }
  assert.equal(xyToSquare(0, 0), "a1");
  assert.equal(xyToSquare(7, 7), "h8");
});

test("xyToSquare: rejects out-of-range and non-integer input", () => {
  for (const args of [
    [-1, 0],
    [0, -1],
    [8, 0],
    [0, 8],
    [1.5, 2],
    ["1", 2],
    [null, null],
    [NaN, 0],
  ]) {
    assert.equal(xyToSquare(args[0], args[1]), null, `expected null for ${JSON.stringify(args)}`);
  }
});

test("boardIndex/squareAt: match rank-8-first board ordering", () => {
  assert.equal(boardIndex(0, 0), 56); // a1 is last-but-8 in the array
  assert.equal(boardIndex(0, 7), 0); // a8 is first
  assert.equal(boardIndex(7, 7), 7); // h8
  assert.equal(boardIndex(7, 0), 63); // h1
  assert.equal(squareAt(0), "a8");
  assert.equal(squareAt(56), "a1");
  assert.equal(squareAt(63), "h1");
  assert.equal(boardIndex(-1, 0), -1);
  assert.equal(squareAt(64), null);
  assert.equal(squareAt(-1), null);
});

test("fileOf/rankOf/isSquare handle bad input", () => {
  assert.equal(fileOf("c6"), 2);
  assert.equal(rankOf("c6"), 5);
  assert.equal(fileOf("nope"), -1);
  assert.equal(rankOf(null), -1);
  assert.equal(isSquare("a1"), true);
  assert.equal(isSquare("a9"), false);
  assert.equal(isSquare(undefined), false);
});

/* ----------------------------------------------------------------- clocks */

test("formatClock: m:ss above 20s", () => {
  assert.equal(formatClock(300000), "5:00");
  assert.equal(formatClock(60000), "1:00");
  assert.equal(formatClock(59000), "0:59");
  assert.equal(formatClock(20000), "0:20");
  assert.equal(formatClock(61000), "1:01");
  assert.equal(formatClock(3600000), "60:00");
});

test("formatClock: tenths strictly below 20s", () => {
  assert.equal(formatClock(19999), "0:19.9");
  assert.equal(formatClock(19900), "0:19.9");
  assert.equal(formatClock(19000), "0:19.0");
  assert.equal(formatClock(12345), "0:12.3");
  assert.equal(formatClock(9900), "0:09.9");
  assert.equal(formatClock(1000), "0:01.0");
  assert.equal(formatClock(999), "0:00.9");
  assert.equal(formatClock(0), "0:00.0");
});

test("formatClock: never throws and clamps junk to zero", () => {
  assert.equal(formatClock(-5), "0:00.0");
  assert.equal(formatClock(NaN), "0:00.0");
  assert.equal(formatClock(undefined), "0:00.0");
  assert.equal(formatClock("abc"), "0:00.0");
  assert.equal(formatClock(null), "0:00.0");
});

test("isLowClock: flags under 10s only", () => {
  assert.equal(isLowClock(9999), true);
  assert.equal(isLowClock(10000), false);
  assert.equal(isLowClock(-1), true);
  assert.equal(isLowClock(NaN), false);
  assert.equal(isLowClock(null), false);
});

test("serverTimeOffset: server minus local, clamped against wild skew", () => {
  assert.equal(serverTimeOffset(1000, 400), 600);
  assert.equal(serverTimeOffset(400, 1000), -600);
  assert.equal(serverTimeOffset(0, 0), 0);
  assert.equal(serverTimeOffset(null, 5), 0);
  assert.equal(serverTimeOffset("x", 5), 0);
  assert.equal(serverTimeOffset(undefined, undefined), 0);
  assert.equal(serverTimeOffset(9e15, 0), 86400000, "a nonsense server clock is clamped to a day");
  assert.equal(serverTimeOffset(-9e15, 0), -86400000);
});

test("clockRemaining: interpolates only the running side", () => {
  const clocks = { w: 300000, b: 295000, initialMs: 300000, incrementMs: 0, running: "w", updatedAt: 10000 };
  // Local clock reads 5s later than updatedAt with no offset -> 5s of white's clock is gone.
  assert.equal(clockRemaining(clocks, "w", 15000, 0), 295000);
  // The idle side does not tick down.
  assert.equal(clockRemaining(clocks, "b", 15000, 0), 295000);
  // serverTime = localNow + offset, so a +2000 offset means the server is 2s
  // AHEAD of the browser: 7s have really elapsed and white has 2s less.
  assert.equal(clockRemaining(clocks, "w", 15000, 2000), 293000);
  // A -2000 offset means the server is 2s behind: only 3s have elapsed.
  assert.equal(clockRemaining(clocks, "w", 15000, -2000), 297000);
  // The client clock lagging behind updatedAt must not add time.
  assert.equal(clockRemaining(clocks, "w", 5000, 0), 300000);
  // A missing or unusable offset counts as zero.
  assert.equal(clockRemaining(clocks, "w", 15000, null), 295000);
  assert.equal(clockRemaining(clocks, "w", 15000, NaN), 295000);
  assert.equal(clockRemaining(clocks, "w", 15000, undefined), 295000);
});

test("clockRemaining: floors at zero and tolerates null clocks", () => {
  const clocks = { w: 1000, b: 5000, running: "w", updatedAt: 0 };
  assert.equal(clockRemaining(clocks, "w", 60000, 0), 0);
  assert.equal(clockRemaining(null, "w", 0, 0), null);
  assert.equal(clockRemaining(undefined, "b", 0, 0), null);
  assert.equal(clockRemaining({ running: "w", updatedAt: 0 }, "w", 0, 0), null);
  assert.equal(clockRemaining({ w: "soon", running: "w", updatedAt: 0 }, "w", 0, 0), null);
  assert.equal(clockRemaining(clocks, "x", 0, 0), null);
  assert.equal(clockRemaining(clocks, "w", NaN, NaN), 1000);
});

/* --------------------------------------------------------------- notation */

test("formatMoveLabel: white gets '.', black gets an ellipsis", () => {
  assert.equal(formatMoveLabel(1, "e4", "w"), "1. e4");
  assert.equal(formatMoveLabel(2, "e5", "b"), "1… e5");
  assert.equal(formatMoveLabel(3, "Nf3", "w"), "2. Nf3");
  assert.equal(formatMoveLabel(4, "Nc6", "b"), "2… Nc6");
});

test("formatMoveLabel: total on junk", () => {
  assert.equal(formatMoveLabel(undefined, undefined, "w"), "1. …");
  assert.equal(formatMoveLabel(0, "", "b"), "1… …");
  assert.equal(formatMoveLabel("7", "Qh5", "b"), "4… Qh5");
  assert.equal(formatMoveLabel(-3, "e4", "w"), "1. e4");
});

test("moveNumberForPly", () => {
  assert.equal(moveNumberForPly(1), 1);
  assert.equal(moveNumberForPly(2), 1);
  assert.equal(moveNumberForPly(3), 2);
  assert.equal(moveNumberForPly(0), 1);
  assert.equal(moveNumberForPly("x"), 1);
});

test("pairMoves: numbered rows with a missing black reply", () => {
  const rows = pairMoves([
    record(1, "w", "e4", "e2", "e4"),
    record(2, "b", "e5", "e7", "e5"),
    record(3, "w", "Nf3", "g1", "f3"),
    record(4, "b", "Nc6", "b8", "c6"),
    record(5, "w", "Bb5", "f1", "b5"),
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].moveNumber, 1);
  assert.equal(rows[0].white.san, "e4");
  assert.equal(rows[0].black.san, "e5");
  assert.equal(rows[2].moveNumber, 3);
  assert.equal(rows[2].white.san, "Bb5");
  assert.equal(rows[2].black, null, "a missing black reply is a null, not a crash");
});

test("pairMoves: tolerates bad input and a black-first history", () => {
  assert.deepEqual(pairMoves(null), []);
  assert.deepEqual(pairMoves(undefined), []);
  assert.deepEqual(pairMoves("nope"), []);
  assert.deepEqual(pairMoves([null, undefined, 7]), [
    { moveNumber: 1, ply: 1, white: null, black: null },
    { moveNumber: 1, ply: 2, white: null, black: null },
    { moveNumber: 2, ply: 3, white: null, black: null },
  ]);
  const rows = pairMoves([record(1, "b", "e5", "e7", "e5")]);
  assert.equal(rows[0].white, null);
  assert.equal(rows[0].black.san, "e5");
});

/* ------------------------------------------------------------ legal moves */

const LEGAL = [
  move("e2", "e3", { san: "e3" }),
  move("e2", "e4", { san: "e4" }),
  move("g1", "f3", { san: "Nf3" }),
  move("g1", "h3", { san: "Nh3" }),
  move("d1", "h5", { san: "Qh5" }),
  move("d1", "g4", { san: "Qg4" }),
  move("a2", "a7", { san: "axb8=Q", captured: "p", promotion: "q" }),
  move("a2", "a7", { san: "axb8=R", captured: "p", promotion: "r" }),
  move("a2", "a7", { san: "axb8=B", captured: "p", promotion: "b" }),
  move("a2", "a7", { san: "axb8=N", captured: "p", promotion: "n" }),
];

test("legalTargetsFrom: only moves that leave the square", () => {
  const found = legalTargetsFrom("g1", LEGAL);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((m) => m.to).sort(), ["f3", "h3"]);
  assert.deepEqual(legalTargetsFrom("e2", LEGAL).map((m) => m.to).sort(), ["e3", "e4"]);
});

test("legalTargetsFrom: total on junk", () => {
  assert.deepEqual(legalTargetsFrom("zz", LEGAL), []);
  assert.deepEqual(legalTargetsFrom("e2", null), []);
  assert.deepEqual(legalTargetsFrom("e2", "nope"), []);
  assert.deepEqual(legalTargetsFrom(null, LEGAL), []);
  assert.deepEqual(legalTargetsFrom("e2", [null, 3, {}]), []);
});

test("needsPromotion: true only for promotion moves", () => {
  assert.equal(needsPromotion("a2", "a7", LEGAL), true);
  assert.equal(needsPromotion("e2", "e4", LEGAL), false);
  assert.equal(needsPromotion("e2", "e5", LEGAL), false);
  assert.equal(needsPromotion(null, "a7", LEGAL), false);
  assert.equal(needsPromotion("a2", "a7", null), false);
});

test("promotionChoices: q/r/b/n in canonical order", () => {
  assert.deepEqual(promotionChoices("a2", "a7", LEGAL), ["q", "r", "b", "n"]);
  assert.deepEqual(promotionChoices("a2", "a7", LEGAL.slice(0, 8)), ["q", "r"]);
  assert.deepEqual(promotionChoices("e2", "e4", LEGAL), []);
  assert.deepEqual(promotionChoices("a2", "a7", null), []);
});

test("findMove: picks the quiet move, or a specific promotion", () => {
  assert.equal(findMove("e2", "e4", LEGAL).san, "e4");
  assert.equal(findMove("a2", "a7", LEGAL, "r").san, "axb8=R");
  assert.equal(findMove("a2", "a7", LEGAL).promotion, "q");
  assert.equal(findMove("e2", "e5", LEGAL), null);
  assert.equal(findMove("a2", "a7", LEGAL, "k"), null);
  assert.equal(findMove(null, null, null), null);
});

test("isCaptureTarget: uses `captured`, then the board", () => {
  assert.equal(isCaptureTarget("a7", "a2", LEGAL, null), true);
  assert.equal(isCaptureTarget("e4", "e2", LEGAL, null), false);
  const board = startingBoard();
  assert.equal(isCaptureTarget("e7", "e2", LEGAL, board), true);
  assert.equal(isCaptureTarget("e4", "e2", LEGAL, board), false);
  assert.equal(isCaptureTarget("e4", "e2", LEGAL, undefined), false);
});

/* ----------------------------------------------------------------- threats */

test("attackedSquares: pairs every capture with its attackers", () => {
  const legalMoves = [
    move("d5", "e4", { san: "dxe4", captured: "p" }),
    move("f5", "e4", { san: "fxe4", captured: "p" }),
    move("b7", "c6", { san: "Nc6" }),
    move("d5", "c4", { san: "dxc4", captured: "p" }),
  ];
  const attacked = attackedSquares(legalMoves, "b");
  assert.equal(attacked.length, 2);
  assert.deepEqual(attacked.map((a) => a.target), ["c4", "e4"]);
  const e4 = attacked.find((a) => a.target === "e4");
  assert.equal(e4.attackers.length, 2);
  assert.deepEqual(e4.attackers.map((a) => a.from).sort(), ["d5", "f5"]);
  assert.equal(e4.attackers[0].captured, "p");
});

test("attackedSquares: quiet moves are not threats", () => {
  const attacked = attackedSquares([move("b7", "c6", { san: "Nc6" })], "b");
  assert.deepEqual(attacked, []);
});

test("attackedSquares: total on junk and wrong colour", () => {
  assert.deepEqual(attackedSquares(null, "b"), []);
  assert.deepEqual(attackedSquares(LEGAL, "x"), []);
  assert.deepEqual(attackedSquares(LEGAL, null), []);
  assert.deepEqual(attackedSquares([null, "x", {}], "w"), []);
});

test("attackedSquares: a synthetic mini position maps own pieces to attackers", () => {
  // White king on e1; black rooks on d8 and f8 can take on d1; knight on c6
  // attacks e5 where a white pawn sits.
  const legalMoves = [
    move("d8", "d1", { san: "Rxd1", captured: "q" }),
    move("f8", "d1", { san: "Rxd1", captured: "q" }),
    move("c6", "e5", { san: "Nxe5", captured: "p" }),
  ];
  const attacked = attackedSquares(legalMoves, "b");
  const d1 = attacked.find((a) => a.target === "d1");
  assert.ok(d1, "d1 should be attacked");
  assert.deepEqual(d1.attackers.map((a) => a.from).sort(), ["d8", "f8"]);
  const e5 = attacked.find((a) => a.target === "e5");
  assert.equal(e5.attackers[0].from, "c6");
});

/* ------------------------------------------------------- history preview */

test("positionPreviewFromHistory: ply 0 is the start position", () => {
  const preview = positionPreviewFromHistory([], 0);
  assert.equal(preview.ply, 0);
  assert.equal(preview.turn, "w");
  assert.equal(preview.lastMove, null);
  assert.equal(preview.board.length, 64);
  assert.equal(preview.board[boardIndex(4, 0)].type, "k"); // e1
  assert.equal(preview.board[boardIndex(4, 0)].color, "w");
  assert.equal(preview.board[boardIndex(4, 7)].type, "k"); // e8
});

test("positionPreviewFromHistory: 1.e4 moves the pawn and hands over the turn", () => {
  const history = [record(1, "w", "e4", "e2", "e4")];
  const preview = positionPreviewFromHistory(history, 1);
  assert.equal(preview.turn, "b");
  assert.equal(preview.board[boardIndex(4, 3)].type, "p");
  assert.equal(preview.board[boardIndex(4, 3)].color, "w");
  assert.equal(preview.board[boardIndex(4, 1)], null, "e2 must be empty");
  assert.deepEqual(preview.lastMove, { from: "e2", to: "e4", san: "e4" });
});

test("positionPreviewFromHistory: two plies, then a clamped request past the end", () => {
  const history = [record(1, "w", "e4", "e2", "e4"), record(2, "b", "e5", "e7", "e5")];
  const preview = positionPreviewFromHistory(history, 2);
  assert.equal(preview.turn, "w");
  assert.equal(preview.board[boardIndex(4, 4)].color, "b");
  assert.equal(preview.board[boardIndex(4, 4)].type, "p");
  assert.equal(preview.board[boardIndex(4, 3)].color, "w");
  const clamped = positionPreviewFromHistory(history, 99);
  assert.equal(clamped.ply, 2);
  const negative = positionPreviewFromHistory(history, -4);
  assert.equal(negative.ply, 0);
  assert.equal(negative.board[boardIndex(4, 1)].type, "p");
});

test("positionPreviewFromHistory: captures and promotions", () => {
  const history = [
    record(1, "w", "e4", "e2", "e4"),
    record(2, "b", "d5", "d7", "d5"),
    record(3, "w", "exd5", "e4", "d5", { capture: "p" }),
    record(4, "b", "Qxd5", "d8", "d5", { capture: "p" }),
  ];
  const preview = positionPreviewFromHistory(history, 3);
  assert.equal(preview.board[boardIndex(3, 4)].type, "p"); // d5 holds the white pawn
  assert.equal(preview.board[boardIndex(3, 4)].color, "w");
  assert.equal(preview.board[boardIndex(4, 3)], null); // e4 is empty
  const after = positionPreviewFromHistory(history, 4);
  assert.equal(after.board[boardIndex(3, 4)].type, "q");
  assert.equal(after.board[boardIndex(3, 4)].color, "b");
  assert.equal(after.board[boardIndex(3, 7)], null, "the black queen left d8");
});

test("positionPreviewFromHistory: promotion replaces the pawn", () => {
  // A legal-ish line: white pushes a pawn to e6, black shuffles, white takes on
  // d7, black shuffles, white promotes on d8.
  const history = [
    record(1, "w", "e4", "e2", "e4"),
    record(2, "b", "a6", "a7", "a6"),
    record(3, "w", "e5", "e4", "e5"),
    record(4, "b", "a5", "a6", "a5"),
    record(5, "w", "e6", "e5", "e6"),
    record(6, "b", "a4", "a5", "a4"),
    record(7, "w", "exd7", "e6", "d7", { capture: "p" }),
    record(8, "b", "a3", "a4", "a3"),
    record(9, "w", "d8=Q", "d7", "d8", { promotion: "q" }),
  ];
  const preview = positionPreviewFromHistory(history, 9);
  assert.equal(preview.board[boardIndex(3, 7)].type, "q", "d8 holds the promoted queen");
  assert.equal(preview.board[boardIndex(3, 7)].color, "w", "and it is white's");
  assert.equal(preview.board[boardIndex(3, 6)], null, "d7 is empty again");
  assert.equal(preview.turn, "b");
  // The same move without a promotion flag keeps the pawn.
  const noPromo = positionPreviewFromHistory([record(1, "w", "d8", "d7", "d8")], 1);
  assert.equal(noPromo.board[boardIndex(3, 7)].type, "p");
});

test("positionPreviewFromHistory: castling brings the rook", () => {
  const board = startingBoard();
  // Clear f1/g1 and put the black king somewhere harmless.
  board[boardIndex(5, 0)] = null;
  board[boardIndex(6, 0)] = null;
  board[boardIndex(4, 7)] = null;
  const history = [record(1, "w", "O-O", "e1", "g1", { castle: "k" })];
  const preview = positionPreviewFromHistory(history, 1);
  assert.equal(preview.board[boardIndex(6, 0)].type, "k"); // g1
  assert.equal(preview.board[boardIndex(5, 0)].type, "r"); // f1
  assert.equal(preview.board[boardIndex(4, 0)], null); // e1 empty
  assert.equal(preview.board[boardIndex(7, 0)], null); // h1 empty
  void board;
});

test("positionPreviewFromHistory: en passant removes the pawn behind", () => {
  const history = [
    record(1, "w", "e5", "e2", "e5"),
    record(2, "b", "a6", "a7", "a6"),
    record(3, "w", "exd6", "e5", "d6", { capture: "p" }),
  ];
  const preview = positionPreviewFromHistory(history, 3);
  assert.equal(preview.board[boardIndex(3, 5)].color, "w", "the capturing pawn is on d6");
  assert.equal(preview.board[boardIndex(3, 5)].type, "p");
});

test("positionPreviewFromHistory: total on garbage", () => {
  const preview = positionPreviewFromHistory(null, 5);
  assert.equal(preview.ply, 0);
  assert.equal(preview.board.length, 64);
  const junk = positionPreviewFromHistory([null, { from: "zz", to: "e4" }, 7], 3);
  assert.equal(junk.ply, 3);
  assert.equal(junk.board.length, 64);
  const nan = positionPreviewFromHistory([], NaN);
  assert.equal(nan.ply, 0);
});

test("applyMoveToBoard: pure, does not mutate the input", () => {
  const board = startingBoard();
  const next = applyMoveToBoard(board, move("e2", "e4"));
  assert.equal(board[boardIndex(4, 1)].type, "p", "the original board is untouched");
  assert.equal(next[boardIndex(4, 3)].type, "p");
  assert.equal(next[boardIndex(4, 1)], null);
  assert.deepEqual(applyMoveToBoard(null, null).length, 64);
});

test("kingSquare: finds both kings in the start position", () => {
  const board = startingBoard();
  assert.equal(kingSquare(board, "w"), "e1");
  assert.equal(kingSquare(board, "b"), "e8");
  assert.equal(kingSquare(board, "x"), null);
  assert.equal(kingSquare(null, "w"), null);
  assert.equal(kingSquare([], "w"), null);
});

test("parseFenPlacement: extracts pieces and squares", () => {
  const board = parseFenPlacement(START);
  assert.equal(board.length, 64);
  assert.equal(board[0].type, "r");
  assert.equal(board[0].color, "b");
  assert.equal(board[0].square, "a8");
  assert.equal(board[63].square, "h1");
  assert.equal(board[63].type, "r");
  assert.equal(board[63].color, "w");
  assert.equal(board[boardIndex(4, 1)].square, "e2");
  assert.equal(parseFenPlacement("nonsense"), null);
  assert.equal(parseFenPlacement(null), null);
  assert.equal(parseFenPlacement("8/8/8/8/8/8/8/9"), null);
  assert.equal(parseFenPlacement("8/8/8/8/8/8/8"), null);
});

test("turnFromFen", () => {
  assert.equal(turnFromFen(START), "w");
  assert.equal(turnFromFen("8/8/8/8/8/8/8/8 b - - 0 1"), "b");
  assert.equal(turnFromFen("8/8/8/8/8/8/8/8"), null);
  assert.equal(turnFromFen(null), null);
});

/* ------------------------------------------------------------- eval bar */

test("evalBarFraction: clamps into 0.02..0.98", () => {
  assert.equal(evalBarFraction(0), 0.02);
  assert.equal(evalBarFraction(-1), 0.02);
  assert.equal(evalBarFraction(1), 0.98);
  assert.equal(evalBarFraction(2), 0.98);
  assert.equal(evalBarFraction(0.5), 0.5);
  assert.equal(evalBarFraction(0.183), 0.183);
  assert.equal(evalBarFraction(0.979), 0.979);
  assert.equal(evalBarFraction(0.981), 0.98);
});

test("evalBarFraction: unknown input is dead level, never throws", () => {
  assert.equal(evalBarFraction(undefined), 0.5);
  assert.equal(evalBarFraction(null), 0.5);
  assert.equal(evalBarFraction(NaN), 0.5);
  assert.equal(evalBarFraction({}), 0.5);
  assert.equal(evalBarFraction("0.7"), 0.5, "a string is not a probability");
  assert.equal(evalBarFraction([]), 0.5);
});

test("evalLabelToCp", () => {
  assert.equal(evalLabelToCp("+0.34"), 34);
  assert.equal(evalLabelToCp("-1.2"), -120);
  assert.equal(evalLabelToCp("0"), 0);
  assert.equal(evalLabelToCp("M3"), 10000);
  assert.equal(evalLabelToCp("nope"), null);
  assert.equal(evalLabelToCp(null), null);
});

/* --------------------------------------------------------------- material */

test("materialCount: full start position is level", () => {
  const totals = materialCount(startingBoard());
  assert.deepEqual(totals, { w: 39, b: 39, diff: 0 });
  assert.equal(formatMaterialDiff(startingBoard()), "=");
});

test("materialCount: counts a real imbalance", () => {
  const board = startingBoard();
  board[boardIndex(3, 3)] = piece("d4", "q", "w");
  const totals = materialCount(board);
  assert.equal(totals.w, 48);
  assert.equal(totals.b, 39);
  assert.equal(totals.diff, 9);
  assert.equal(formatMaterialDiff(board), "+9");
  board[boardIndex(0, 7)] = null;
  assert.equal(formatMaterialDiff(board), "+14");
});

test("materialCount: total on junk", () => {
  assert.deepEqual(materialCount(null), { w: 0, b: 0, diff: 0 });
  assert.deepEqual(materialCount([null, "x", 5, { type: "p" }, { type: "p", color: "x" }]), {
    w: 0,
    b: 0,
    diff: 0,
  });
  assert.equal(materialCount([{ type: "p", color: "b" }]).diff, -1);
});

/* ------------------------------------------------------------ presentation */

test("dimensionLabel covers the contract's dimension keys", () => {
  assert.equal(dimensionLabel("quality"), "Quality");
  assert.equal(dimensionLabel("safety"), "Safety");
  assert.equal(dimensionLabel("activity"), "Activity");
  assert.equal(dimensionLabel("kingPressure"), "King pressure");
  assert.equal(dimensionLabel("search"), "Code search");
  assert.equal(dimensionLabel("choice"), "Jev's choice");
});

test("dimensionLabel: unknown keys degrade gracefully", () => {
  assert.equal(dimensionLabel("someNewThing"), "Some new thing");
  assert.equal(dimensionLabel("snake_case_key"), "Snake case key");
  assert.equal(dimensionLabel(""), "");
  assert.equal(dimensionLabel(null), "");
  assert.equal(dimensionLabel(42), "");
});

test("formatPercent / compactNumber / formatSeconds / formatTokens", () => {
  assert.equal(formatPercent(0.315), "32%");
  assert.equal(formatPercent(0.315, 1), "31.5%");
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(1), "100%");
  assert.equal(formatPercent(null), "–");
  assert.equal(formatPercent(undefined), "–");
  assert.equal(formatPercent({}), "–");
  assert.equal(formatPercent("0.5"), "–", "a string is not a probability");
  assert.equal(compactNumber(4210), "4.2k");
  assert.equal(compactNumber(999), "999");
  assert.equal(compactNumber(0), "0");
  assert.equal(formatSeconds(1350), "1.4");
  assert.equal(formatSeconds(-5), "0.0");
  assert.equal(formatTokens({ input_tokens: 4210, output_tokens: 180 }), "4.2k in / 180 out");
  assert.equal(formatTokens(null), "");
  assert.equal(formatTokens(undefined), "");
});

test("colorName / statusText / asText / clamp", () => {
  assert.equal(colorName("w"), "White");
  assert.equal(colorName("b"), "Black");
  assert.equal(colorName(null), "—");
  assert.equal(statusText(null).text, "No game loaded");
  const check = statusText({ turn: "w", status: { over: false }, check: { inCheck: true, square: "e1" } });
  assert.equal(check.text, "White to move — check");
  assert.equal(check.tone, "warn");
  const over = statusText({ turn: "b", status: { over: true, result: "1-0", reason: "resignation" } });
  assert.equal(over.text, "White wins — resignation");
  const mate = statusText({
    turn: "b",
    status: { over: false },
    check: { inCheck: true, square: "e8" },
    legalMoves: [],
  });
  assert.equal(mate.text, "Black is checkmated");
  const stale = statusText({ turn: "w", status: { over: false }, legalMoves: [] });
  assert.equal(stale.text, "Stalemate");
  assert.equal(statusText({}).text, "White to move");
  assert.equal(asText("x"), "x");
  assert.equal(asText(null, "fallback"), "fallback");
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp("0.4", 0, 1), 0.4);
  assert.equal(clamp("x", 2, 3), 2);
});

test("pieceGlyph / pieceName use solid glyphs only", () => {
  const solid = { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" };
  for (const [type, glyph] of Object.entries(solid)) {
    assert.equal(pieceGlyph(type), glyph);
  }
  const outline = ["♔", "♕", "♖", "♗", "♘", "♙"];
  for (const type of ["p", "n", "b", "r", "q", "k"]) {
    assert.ok(!outline.includes(pieceGlyph(type)), `${type} must not use an outline glyph`);
  }
  assert.equal(pieceGlyph("x"), "");
  assert.equal(pieceGlyph(null), "");
  assert.equal(pieceName("n"), "knight");
  assert.equal(pieceName("x"), "");
});

/* ------------------------------------------------------------- jev panel */

test("candidateRows: sorts by composite, marks the chosen row", () => {
  const jev = {
    chosenSan: "Nf3",
    candidates: [
      { san: "Bb5", from: "f1", to: "b5", searchRank: 1, composite: 0.4, choiceProb: 0.1, dims: { quality: 0.5 } },
      { san: "Nf3", from: "g1", to: "f3", searchRank: 3, composite: 0.8, choiceProb: 0.6, dims: { quality: 0.9, safety: 0.7 } },
    ],
  };
  const rows = candidateRows(jev);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].san, "Nf3");
  assert.equal(rows[0].chosen, true);
  assert.equal(rows[1].san, "Bb5");
  assert.equal(rows[1].chosen, false);
  assert.equal(rows[0].composite, 0.8);
  assert.equal(rows[0].dims.length, 2);
  assert.deepEqual(dimensionKeys(jev), ["quality", "safety"]);
});

test("candidateRows: total on junk, and on null fields", () => {
  assert.deepEqual(candidateRows(null), []);
  assert.deepEqual(candidateRows({}), []);
  const rows = candidateRows({ candidates: [null, { san: 5, choiceProb: 4, composite: -3 }] });
  assert.equal(rows.length, 2);
  // Rows with a real composite score sort ahead of rows without one.
  assert.equal(rows[0].san, "?", "a non-string san becomes a placeholder");
  assert.equal(rows[0].choiceProb, 1, "a numeric out-of-range value is clamped into 0..1");
  assert.equal(rows[0].composite, 0, "a numeric composite below zero clamps to 0");
  assert.equal(rows[1].choiceProb, null, "a non-numeric choiceProb is 'not asked', not 1");
  assert.equal(rows[1].composite, null, "a non-numeric composite is unknown");
  const clamped = candidateRows({ candidates: [{ san: "e4", choiceProb: 4, composite: -3, dims: { safety: 9 } }] });
  assert.equal(clamped[0].choiceProb, 1);
  assert.equal(clamped[0].composite, 0);
  assert.equal(clamped[0].dims[0].value, 1);
  assert.deepEqual(clamped[0].dims[0].label, "Safety");
});

test("weightEntries: sorted, total on junk", () => {
  const entries = weightEntries({ search: 0.35, choice: 0.15, quality: 0.2 });
  assert.deepEqual(entries.map((e) => e.key), ["search", "quality", "choice"]);
  assert.equal(entries[0].label, "Code search");
  assert.deepEqual(weightEntries(null), []);
  assert.deepEqual(weightEntries({ bad: "x" }), []);
});

test("auditRows: normalises entries", () => {
  const rows = auditRows([{ question: "Hangs a piece?", noul: 0.12, veto: false }, {}, null]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].question, "Hangs a piece?");
  assert.equal(rows[0].noul, 0.12);
  assert.equal(rows[0].veto, false);
  assert.equal(rows[1].noul, null);
  assert.deepEqual(auditRows(null), []);
});

test("latestJevRecord: finds the newest Jev move", () => {
  const history = [
    record(1, "w", "e4", "e2", "e4", { by: "human" }),
    record(2, "b", "e5", "e7", "e5", { by: "jev", jev: { chosenSan: "e5" } }),
    record(3, "w", "Nf3", "g1", "f3", { by: "human" }),
  ];
  assert.equal(latestJevRecord(history).ply, 2);
  assert.equal(latestJevRecord([record(1, "w", "e4", "e2", "e4")]), null);
  assert.equal(latestJevRecord(null), null);
  assert.equal(latestJevRecord([]), null);
});

/* ------------------------------------------------------------------ pgn */

test("pgnFromGame: tags, move text, result and line wrapping", () => {
  const game = {
    id: "g_test",
    createdAt: Date.UTC(2026, 0, 2),
    players: { w: { name: "You" }, b: { name: "Balanced" } },
    status: { over: true, result: "1-0", reason: "resignation" },
    history: [
      record(1, "w", "e4", "e2", "e4"),
      record(2, "b", "e5", "e7", "e5"),
      record(3, "w", "Nf3", "g1", "f3"),
    ],
  };
  const pgn = pgnFromGame(game);
  assert.ok(pgn.includes('[White "You"]'), pgn);
  assert.ok(pgn.includes('[Black "Balanced"]'), pgn);
  assert.ok(pgn.includes('[Result "1-0"]'), pgn);
  assert.ok(pgn.includes('[Date "2026.01.02"]'), pgn);
  assert.ok(pgn.includes("1. e4 e5 2. Nf3 1-0"), pgn);
  assert.ok(pgn.endsWith("\n"));
});

test("pgnFromGame: total on junk, and still valid PGN", () => {
  const fromNull = pgnFromGame(null);
  assert.ok(fromNull.includes('[Result "*"]'), fromNull);
  assert.ok(fromNull.includes('[White "White"]'), fromNull);
  assert.ok(fromNull.includes('[Event "JevChess"]'), fromNull);
  assert.ok(fromNull.endsWith("\n"));
  const fromEmpty = pgnFromGame({});
  assert.ok(fromEmpty.includes('[Result "*"]'));
  const fromJunk = pgnFromGame({ status: "nope", history: "nope", players: 5 });
  assert.ok(fromJunk.includes('[Result "*"]'));
});

/* ------------------------------------------------------------------ misc */

test("startingBoard: fresh array each call", () => {
  const a = startingBoard();
  const b = startingBoard();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a[0] = null;
  assert.ok(b[0], "mutating one board must not affect the next");
});

done();
