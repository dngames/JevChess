/**
 * tests/perft.test.mjs
 *
 * Correctness harness for src/engine/chess.js:
 *   1. Perft node counts against the standard reference positions.
 *   2. Targeted rule assertions (SAN for en passant, promotion, castling,
 *      checkmate, SAN disambiguation; move/undo round-trip; illegal input).
 *
 * Run: node tests/perft.test.mjs
 * Exits non-zero when any expectation fails.
 */

import { Chess } from '../src/engine/chess.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const PERFT_CASES = [
  { name: 'startpos', fen: START, expected: [20, 400, 8902, 197281, 4865609] },
  {
    name: 'kiwipete',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    expected: [48, 2039, 97862, 4085603],
  },
  {
    name: 'pos3',
    fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    expected: [14, 191, 2812, 43238, 674624],
  },
  {
    name: 'pos4',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    expected: [6, 264, 9467, 422333],
  },
  {
    name: 'pos5',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    expected: [44, 1486, 62379, 2103487],
  },
  {
    name: 'pos6',
    fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
    expected: [46, 2079, 89890, 3894594],
  },
];

let checks = 0;
let failures = 0;

function ok(label, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function eq(label, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label} -- expected ${e}, got ${a}`);
  }
}

function throws(label, fn) {
  checks++;
  try {
    fn();
    failures++;
    console.log(`  FAIL  ${label} -- expected a throw, none happened`);
  } catch {
    console.log(`  PASS  ${label}`);
  }
}

/* ------------------------------------------------------------------ *
 * 1. Perft
 * ------------------------------------------------------------------ */

console.log('== perft ==\n');
console.log(
  `${'position'.padEnd(10)} ${'depth'.padStart(5)} ${'expected'.padStart(10)} ${'actual'.padStart(10)} ${'ms'.padStart(8)}  status`,
);
console.log('-'.repeat(54));

const perftTimes = [];

for (const testCase of PERFT_CASES) {
  for (let d = 0; d < testCase.expected.length; d++) {
    const depth = d + 1;
    const expected = testCase.expected[d];
    const game = new Chess(testCase.fen);
    const t0 = performance.now();
    const actual = game.perft(depth);
    const ms = performance.now() - t0;
    const status = actual === expected ? 'OK' : `MISMATCH (off by ${actual - expected})`;
    if (actual !== expected) failures++;
    checks++;
    if (testCase.name === 'startpos' && depth === 4) perftTimes.push({ label: 'start perft(4)', ms });
    console.log(
      `${testCase.name.padEnd(10)} ${String(depth).padStart(5)} ${String(expected).padStart(10)} ${String(actual).padStart(10)} ${ms.toFixed(1).padStart(8)}  ${status}`,
    );
  }
}

for (const t of perftTimes) {
  ok(`${t.label} under 5000 ms (${t.ms.toFixed(1)} ms)`, t.ms < 5000);
}

/* ------------------------------------------------------------------ *
 * 2. Targeted rule assertions
 * ------------------------------------------------------------------ */

console.log('\n== rules & SAN ==\n');

// En passant SAN: white pawn e5, black just played d7-d5, ep target d6.
{
  const epFen = 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3';
  const game = new Chess(epFen);
  const epMoves = game.moves({ square: 'e5' }).filter((m) => m.to === 'd6');
  eq('en passant: exactly one e5->d6 move', epMoves.length, 1);
  if (epMoves.length === 1) {
    const m = epMoves[0];
    eq('en passant SAN', m.san, 'exd6');
    eq('en passant flags contains "e"', m.flags.includes('e'), true);
    eq('en passant captured piece', m.captured, 'p');
    eq('en passant before FEN', m.before, epFen);
    const applied = game.move('exd6');
    ok('en passant move applied', applied !== null && applied.san === 'exd6');
    eq('en passant removed the d5 pawn', game.get('d5'), null);
    eq('en passant white pawn now on d6', game.get('d6'), { square: 'd6', type: 'p', color: 'w' });
  }
  const undid = game.undo();
  ok('en passant undo returns the move', undid !== null && undid.san === 'exd6');
  eq('en passant undo restores FEN', game.fen(), epFen);
}

// En passant that would expose the king is not legal.
{
  // Black rook e8, white king e1, white pawn e5, black pawn d5 just double-pushed:
  // capturing en passant removes BOTH pawns from the e-file, exposing the king.
  const pinned = new Chess('4r2k/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
  const sans = pinned.moves().map((m) => m.san);
  ok('en passant: pinned ep capture is illegal', !sans.includes('exd6'), sans.join(','));
  // Same shape with the king off the e-file: the capture is legal (fixture sanity check).
  const unpinned = new Chess('4r2k/8/8/3pP3/8/8/8/K7 w - d6 0 2');
  ok('en passant: same capture legal when unpinned', unpinned.moves().map((m) => m.san).includes('exd6'));
}

// Promotion: all four pieces generated, e8=Q+ SAN.
{
  const game = new Chess('7k/4P3/8/8/8/8/8/K7 w - - 0 1');
  const promos = game.moves({ square: 'e7' }).filter((m) => m.to === 'e8');
  eq('promotion: four promotion moves from e7', promos.length, 4);
  eq(
    'promotion: piece set',
    promos.map((m) => m.promotion).sort(),
    ['b', 'n', 'q', 'r'],
  );
  eq(
    'promotion: all flagged with p',
    promos.every((m) => m.flags.includes('p')),
    true,
  );
  const queen = promos.find((m) => m.promotion === 'q');
  eq('promotion SAN e8=Q+', queen.san, 'e8=Q+');
  eq('promotion SAN e8=N', promos.find((m) => m.promotion === 'n').san, 'e8=N');

  const g2 = new Chess('7k/4P3/8/8/8/8/8/K7 w - - 0 1');
  const looseApplied = g2.move({ from: 'e7', to: 'e8' });
  ok('promotion defaults to queen', looseApplied !== null && looseApplied.promotion === 'q' && looseApplied.san === 'e8=Q+');

  const g3 = new Chess('7k/4P3/8/8/8/8/8/K7 w - - 0 1');
  const underpromo = g3.move({ from: 'e7', to: 'e8', promotion: 'n' });
  ok('promotion: explicit underpromotion honoured', underpromo !== null && underpromo.promotion === 'n');
}

// Castling SAN, flags, rook relocation, and the through/out-of-check restrictions.
{
  const castleFen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  const game = new Chess(castleFen);
  const sans = game.moves().map((m) => m.san);
  ok('castling: O-O available', sans.includes('O-O'));
  ok('castling: O-O-O available', sans.includes('O-O-O'));
  const ks = game.moves().find((m) => m.san === 'O-O');
  eq('castling flags kingside', ks.flags, 'k');
  eq('castling destination', ks.to, 'g1');
  const qs = game.moves().find((m) => m.san === 'O-O-O');
  eq('castling flags queenside', qs.flags, 'q');
  eq('castling destination', qs.to, 'c1');

  const applied = game.move('O-O');
  ok('castling applied', applied !== null && applied.san === 'O-O');
  eq('castling rook relocated to f1', game.get('f1'), { square: 'f1', type: 'r', color: 'w' });
  eq('castling king on g1', game.get('g1'), { square: 'g1', type: 'k', color: 'w' });
  eq('castling h1 vacated', game.get('h1'), null);
  eq('castling: white rights revoked in FEN', game.fen().split(' ')[2], 'kq');
  game.undo();
  eq('castling undo restores FEN', game.fen(), castleFen);

  // Rook move revokes only that side's right.
  const rookMoved = new Chess(castleFen);
  rookMoved.move('Rg1');
  eq('castling: rook move revokes kingside right', rookMoved.fen().split(' ')[2], 'Qkq');

  // Rook captured on its home square revokes that right.
  const rookTaken = new Chess(castleFen);
  const takenMove = rookTaken.move('Rxa8+');
  ok('castling: Rxa8+ legal', takenMove !== null && takenMove.san === 'Rxa8+');
  eq('castling: captured rook revokes the right', rookTaken.fen().split(' ')[2], 'Kk');

  // Black rook on f8 attacks f1: kingside castling is illegal, queenside is fine.
  const throughCheck = new Chess('r3kr2/8/8/8/8/8/8/R3K2R w KQq - 0 1');
  const sans2 = throughCheck.moves().map((m) => m.san);
  ok('castling: through check blocked (no O-O)', !sans2.includes('O-O'));
  ok('castling: O-O-O still legal', sans2.includes('O-O-O'));

  // Castling out of check is illegal.
  const inCheck = new Chess('4r1k1/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  const sans3 = inCheck.moves().map((m) => m.san);
  ok('castling: white is in check in this fixture', inCheck.isCheck(), true);
  ok('castling: not allowed out of check', !sans3.includes('O-O') && !sans3.includes('O-O-O'));
}

// Checkmate SAN Qh7#.
{
  const game = new Chess('7k/8/5N2/8/8/3Q4/8/K7 w - - 0 1');
  const mate = game.moves().find((m) => m.san === 'Qh7#');
  ok('mate: Qh7# generated', mate !== undefined);
  if (mate) {
    eq('mate: SAN carries no origin disambiguation', mate.san, 'Qh7#');
    const applied = game.move('Qh7#');
    ok('mate: applied', applied !== null && applied.san === 'Qh7#');
    eq('mate: isCheckmate', game.isCheckmate(), true);
    eq('mate: isGameOver', game.isGameOver(), true);
    eq('mate: result', game.result(), '1-0');
  }
}

// SAN disambiguation: file, rank, and none-when-unambiguous.
{
  const knights = new Chess('4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1');
  const knightSans = knights.moves().map((m) => m.san);
  ok('disambiguation: Nbd2 generated', knightSans.includes('Nbd2'), knightSans.filter((s) => s.endsWith('d2')).join(','));
  ok('disambiguation: Nfd2 generated', knightSans.includes('Nfd2'), knightSans.filter((s) => s.endsWith('d2')).join(','));
  ok('disambiguation: Ne5 unambiguous', knightSans.includes('Ne5'));

  const rooks = new Chess('7k/8/8/8/8/R7/8/R6K w - - 0 1');
  const rookSans = rooks.moves().map((m) => m.san);
  ok('disambiguation: R1a2 generated', rookSans.includes('R1a2'), rookSans.filter((s) => s.endsWith('a2')).join(','));
  ok('disambiguation: R3a2 generated', rookSans.includes('R3a2'), rookSans.filter((s) => s.endsWith('a2')).join(','));
}

// move()/undo() round-trip restores exact FENs.
{
  const game = new Chess();
  const fens = [game.fen()];
  const played = [];
  const script = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7'];
  for (const san of script) {
    const m = game.move(san);
    ok(`round-trip: played ${san}`, m !== null && m.san === san, m ? `got ${m.san}` : 'got null');
    if (!m) break;
    played.push(m);
    fens.push(game.fen());
  }
  eq('round-trip: history length', game.history().length, played.length);
  eq('round-trip: history() returns SAN strings', game.history(), script.slice(0, played.length));
  const verbose = game.history({ verbose: true });
  eq(
    'round-trip: verbose history has the exact contract fields',
    Object.keys(verbose[0]).sort(),
    ['after', 'before', 'captured', 'color', 'flags', 'from', 'piece', 'promotion', 'san', 'to'],
  );
  eq('round-trip: verbose entry san', verbose[0].san, 'e4');
  eq('round-trip: verbose entry after FEN matches', verbose[0].after, fens[1]);

  let restored = true;
  for (let i = played.length - 1; i >= 0; i--) {
    const undone = game.undo();
    if (!undone || game.fen() !== fens[i]) {
      restored = false;
      console.log(`      (mismatch after undoing ${undone ? undone.san : 'null'}: ${game.fen()})`);
      break;
    }
  }
  ok('round-trip: undo restores every intermediate FEN', restored);
  eq('round-trip: back at the initial FEN', game.fen(), fens[0]);
  eq('round-trip: history empty', game.history().length, 0);
  eq('round-trip: undo on empty history is null', game.undo(), null);

  // Same round-trip from a loaded mid-game FEN (Kiwipete), driving the engine
  // from its own move list so the sequence is guaranteed legal.
  const kiwipeteFen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  const kiwipete = new Chess(kiwipeteFen);
  const kFens = [kiwipete.fen()];
  const kPlayed = [];
  for (let ply = 0; ply < 12; ply++) {
    const options = kiwipete.moves();
    if (options.length === 0) break;
    const m = kiwipete.move(options[0].san);
    if (!m) break;
    kPlayed.push(m);
    kFens.push(kiwipete.fen());
  }
  ok('round-trip (kiwipete): played a full sequence', kPlayed.length === 12, `played ${kPlayed.length}`);
  let kRestored = true;
  for (let i = kPlayed.length - 1; i >= 0; i--) {
    const undone = kiwipete.undo();
    if (!undone || kiwipete.fen() !== kFens[i]) {
      kRestored = false;
      break;
    }
  }
  ok('round-trip (kiwipete): undo restores every intermediate FEN', kRestored);
  eq('round-trip (kiwipete): back at the loaded FEN', kiwipete.fen(), kiwipeteFen);
}

// Illegal / unparseable input returns null and never throws.
{
  const game = new Chess();
  const inputs = [
    'e2e5',
    'Qh5',
    'not-a-move',
    '',
    '   ',
    'e9e4',
    'Nb1',
    null,
    undefined,
    42,
    {},
    { from: 'e2', to: 'e5' },
    { from: 'zz', to: 'e4' },
    { from: 'e2' },
    { from: 'e7', to: 'e8', promotion: 'x' },
  ];
  for (const input of inputs) {
    let result = 'THREW';
    try {
      result = game.move(input);
    } catch (err) {
      result = `THREW: ${err.message}`;
    }
    eq(`illegal input ${JSON.stringify(input)} -> null`, result, null);
  }
  eq('illegal input did not change the FEN', game.fen(), START);
}

// Loose object and coordinate-notation input still works.
{
  const game = new Chess();
  const m1 = game.move({ from: 'e2', to: 'e4' });
  ok('loose object move applied', m1 !== null && m1.san === 'e4');
  game.undo();
  const m2 = game.move('g1f3');
  ok('coordinate notation applied', m2 !== null && m2.san === 'Nf3');
  const m3 = new Chess().move('e7e8q');
  ok('coordinate notation with an impossible move is null', m3 === null);
  const m4 = new Chess('7k/4P3/8/8/8/8/8/K7 w - - 0 1').move('e7e8q');
  ok('coordinate notation honours the promotion piece', m4 !== null && m4.san === 'e8=Q+');
}

// Invalid FEN throws; reset()/load()/fen() round-trip.
{
  throws('invalid FEN throws', () => new Chess('8/8/8 w - - 0 1'));
  throws('invalid FEN throws (bad piece)', () => new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNX w KQkq - 0 1'));
  throws('invalid FEN throws (no black king)', () => new Chess('8/8/8/8/8/8/8/K7 w - - 0 1'));
  throws('invalid FEN throws (ep rank inconsistent with the side to move)', () => new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e3 0 1'));
  throws('invalid FEN throws (bad ep square)', () => new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e9 0 1'));

  const game = new Chess();
  eq('default start FEN', game.fen(), START);
  for (const testCase of PERFT_CASES) {
    game.load(testCase.fen);
    eq(`load/fen round-trip: ${testCase.name}`, game.fen(), testCase.fen);
  }
  game.reset();
  eq('reset returns to the start position', game.fen(), START);
}

// Board / get / squareColor / misc accessors.
{
  const game = new Chess();
  const b = game.board();
  eq('board: 8 rows', b.length, 8);
  eq('board: rank 8 first', b[0][0], { square: 'a8', type: 'r', color: 'b' });
  eq('board: e1 king', b[7][4], { square: 'e1', type: 'k', color: 'w' });
  eq('board: empty middle', b[3][3], null);
  eq('get: e1', game.get('e1'), { square: 'e1', type: 'k', color: 'w' });
  eq('get: e4 empty', game.get('e4'), null);
  eq('get: bogus square', game.get('z9'), null);
  eq('squareColor a1', game.squareColor('a1'), 'dark');
  eq('squareColor h1', game.squareColor('h1'), 'light');
  eq('squareColor e4', game.squareColor('e4'), 'light');
  eq('squareColor invalid', game.squareColor('q7'), null);
  eq('turn', game.turn(), 'w');
  eq('moveNumber', game.moveNumber(), 1);
  eq('halfMoves', game.halfMoves(), 0);
  eq('result while running', game.result(), null);
  eq('ascii first line', game.ascii().split('\n')[0], '   +------------------------+');
  eq('ascii rank 8 line', game.ascii().split('\n')[1], ' 8 | r  n  b  q  k  b  n  r |');

  game.move('e4');
  eq('halfMoves reset by a pawn move', game.halfMoves(), 0);
  game.move('Nf6');
  eq('halfMoves incremented by a quiet move', game.halfMoves(), 1);
  eq('moveNumber after black moved', game.moveNumber(), 2);
  eq('turn flips back to white', game.turn(), 'w');
}

// Draws: stalemate, insufficient material, fifty-move, threefold.
{
  const stalemate = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  eq('stalemate: not in check', stalemate.isCheck(), false);
  eq('stalemate: inCheck alias agrees', stalemate.inCheck(), false);
  eq('stalemate: detected', stalemate.isStalemate(), true);
  eq('stalemate: no legal moves', stalemate.moves().length, 0);
  eq('stalemate: result', stalemate.result(), '1/2-1/2');

  const mate = new Chess('7k/8/5N2/8/8/3Q4/8/K7 w - - 0 1');
  mate.move('Qh7#');
  eq('checkmate: isCheck', mate.isCheck(), true);
  eq('checkmate: not stalemate', mate.isStalemate(), false);

  eq('insufficient: K vs K', new Chess('8/8/8/4k3/8/4K3/8/8 w - - 0 1').isInsufficientMaterial(), true);
  eq('insufficient: K+N vs K', new Chess('8/8/8/4k3/8/4K3/4N3/8 w - - 0 1').isInsufficientMaterial(), true);
  eq('insufficient: K+R vs K is not', new Chess('8/8/8/4k3/8/4K3/4R3/8 w - - 0 1').isInsufficientMaterial(), false);
  eq('insufficient: same-colour bishops', new Chess('5b1k/8/8/8/8/8/8/2B4K w - - 0 1').isInsufficientMaterial(), true);
  eq(
    'insufficient: opposite-colour bishops is not',
    new Chess('5b1k/8/8/8/8/8/8/3B3K w - - 0 1').isInsufficientMaterial(),
    false,
  );

  eq('fifty-move: not yet', new Chess('8/8/8/4k3/8/4K3/4R3/8 w - - 99 60').isFiftyMoveDraw(), false);
  eq('fifty-move: at 100', new Chess('8/8/8/4k3/8/4K3/4R3/8 w - - 100 60').isFiftyMoveDraw(), true);
  eq('fifty-move: at 150', new Chess('8/8/8/4k3/8/4K3/4R3/8 w - - 150 80').isFiftyMoveDraw(), true);

  const rep = new Chess();
  eq('threefold: false before any repetition', rep.isThreefoldRepetition(), false);
  const shuffle = ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8'];
  for (const san of shuffle) {
    if (!rep.move(san)) {
      failures++;
      checks++;
      console.log(`  FAIL  threefold: could not play ${san}`);
      break;
    }
  }
  eq('threefold: repetition after 8 knight moves', rep.isThreefoldRepetition(), true);
  eq('threefold: draw result', rep.result(), '1/2-1/2');
  eq('threefold: halfmove clock still below 100', rep.isFiftyMoveDraw(), false);
  rep.undo();
  eq('threefold: not a repetition after undo', rep.isThreefoldRepetition(), false);

  // Repetition only counts positions since construction / the last load().
  const loaded = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  for (const san of ['O-O', 'O-O-O', 'Rfe1']) loaded.move(san);
  eq('threefold: positions before a loaded FEN are not counted', loaded.isThreefoldRepetition(), false);
}

// PGN.
{
  const game = new Chess();
  game.move('e4');
  game.move('e5');
  game.move('Nf3');
  const pgn = game.pgn();
  ok('pgn: seven-tag roster present', ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'].every((t) => pgn.includes(`[${t} `)));
  ok('pgn: no SetUp tag from the standard start', !pgn.includes('[SetUp '));
  ok('pgn: movetext', pgn.includes('1. e4 e5 2. Nf3 *'), pgn.replace(/\n/g, '\\n'));
  ok('pgn: Result tag is * while unfinished', pgn.includes('[Result "*"]'));

  const fromFen = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  fromFen.move('O-O');
  const pgn2 = fromFen.pgn();
  ok('pgn: SetUp/FEN tags for a non-standard start', pgn2.includes('[SetUp "1"]') && pgn2.includes('[FEN "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"]'));

  const blackFirst = new Chess('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1');
  blackFirst.move('O-O-O');
  blackFirst.move('O-O');
  ok('pgn: black-to-move movetext numbering', blackFirst.pgn().includes('1... O-O-O 2. O-O *'), blackFirst.pgn().replace(/\n/g, '\\n'));

  const finished = new Chess('7k/8/5N2/8/8/3Q4/8/K7 w - - 0 1');
  finished.move('Qh7#');
  ok(
    'pgn: finished game carries the result',
    finished.pgn().includes('[Result "1-0"]') && finished.pgn().includes('1. Qh7# 1-0'),
    finished.pgn().replace(/\n/g, '\\n'),
  );
}

// Static perft, black win, and perft leaving the position untouched.
{
  eq('static Chess.perft from the start position (depth 3)', Chess.perft(START, 3), 8902);
  eq('static Chess.perft from a FEN (depth 3)', Chess.perft('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 3), 97862);
  eq('static Chess.perft with no FEN (depth 2)', Chess.perft(undefined, 2), 400);

  const game = new Chess('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const before = game.fen();
  const nodes = game.perft(3);
  eq('perft does not disturb the position', game.fen(), before);
  eq('perft node count', nodes, 97862);

  const blackMate = new Chess('8/8/8/8/8/k7/2q5/K7 b - - 0 1');
  const mating = blackMate.move('Qb2#');
  ok('black mate: applied', mating !== null && mating.san === 'Qb2#');
  eq('black mate: isCheckmate', blackMate.isCheckmate(), true);
  eq('black mate: result', blackMate.result(), '0-1');
  eq('black mate: pgn result tag', blackMate.pgn().includes('[Result "0-1"]'), true);
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log(`\n${checks} checks, ${failures} failure(s)`);
if (failures > 0) {
  console.log('RESULT: FAIL');
  process.exitCode = 1;
} else {
  console.log('RESULT: PASS');
}
