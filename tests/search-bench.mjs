/**
 * Search benchmark. Not a correctness test — it reports how long the code half of a
 * move takes, so the strategy defaults (3 ply requested, 1.4 s budget) stay defensible
 * on a normal machine. Run with: node tests/search-bench.mjs
 *
 * "depth reached" is the important column: the search deepens iteratively and stops at
 * the time budget, so a busy middlegame legitimately reports a shallower completed
 * iteration than requested. That is the designed behaviour, not a failure.
 */
import { Chess } from "../src/engine/chess.js";
import { analyzeRoot } from "../src/engine/search.js";
import { DEFAULT_TIME_BUDGET_MS } from "../src/strategies.js";

const positions = [
  ["startpos", undefined],
  ["open middlegame", "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 6"],
  ["tactical middlegame", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"],
  ["endgame", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1"],
  ["many pieces, open", "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10"],
];

const TIME_BUDGET_MS = DEFAULT_TIME_BUDGET_MS;
const QUIESCENCE = 2;

console.log(`budget per analysis: ${TIME_BUDGET_MS} ms (DEFAULT_TIME_BUDGET_MS)\n`);
console.log("position                 asked  got   moves    nodes      ms   best move");
let overruns = 0;
for (const [name, fen] of positions) {
  for (const depth of [2, 3, 4]) {
    const chess = fen ? new Chess(fen) : new Chess();
    const legal = chess.moves().length;
    const started = Date.now();
    const analysis = analyzeRoot(chess, { depth, quiescence: QUIESCENCE, timeBudgetMs: TIME_BUDGET_MS });
    const elapsed = Date.now() - started;
    if (elapsed > TIME_BUDGET_MS * 2) overruns += 1;
    console.log(
      `${name.padEnd(24)} ${String(depth).padStart(5)} ${String(analysis.depth).padStart(4)} ${String(legal).padStart(6)} ` +
        `${String(analysis.nodes).padStart(8)} ${String(elapsed).padStart(5)}   ${analysis.moves[0].san}${analysis.aborted ? "  (budget)" : ""}`,
    );
  }
}

console.log(`\nA move's code half is the depth-3 row for the strategy's own budget.`);
if (overruns > 0) {
  console.log(`WARNING: ${overruns} analysis runs took more than twice the budget; check the abort check in search.js.`);
} else {
  console.log("Every run respected the budget (within 2x, which the abort granularity allows).");
}
