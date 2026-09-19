/**
 * A single game: rules, players, clocks, move records, and the async AI turn.
 *
 * The server keeps a Game per id and subscribes to its events; `snapshot()` is the
 * single source of truth the browser renders (see CONTRACT.md). Everything that can
 * fail (Jev unreachable, an unreadable answer, a clock flag) is turned into a notice
 * and the game keeps going.
 */

import { Chess } from "./engine/chess.js";
import { analyzeRoot, cpToUnit, MATE_THRESHOLD } from "./engine/search.js";
import { resolveStrategy, DEFAULT_STRATEGY_ID, PIPELINES } from "./strategies.js";
import { selectMove } from "./jev/pipelines.js";
import { noul } from "./jev/client.js";
import { readNoulAnswer } from "./jev/questions.js";
import { applyPlan, describePlan } from "./llm/plan.js";
import { phaseForPosition, reviewPlan, shouldReview } from "./llm/strategist.js";

const AI_MOVE_DELAY_MS = 700;
const CLOCK_TICK_MS = 250;
const MAX_PLIES = 400;

export class Game {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {"human-vs-jev"|"jev-vs-jev"} opts.mode
   * @param {"w"|"b"} [opts.humanColor]
   * @param {string} [opts.fen]
   * @param {{initialMs:number,incrementMs:number}|null} [opts.timeControl]
   * @param {Record<string,{strategyId?:string,weights?:object}>} opts.playerConfigs
   * @param {object} opts.jevClient
   * @param {string} opts.modelName
   * @param {boolean} opts.hasApiKey
   * @param {number} [opts.aiMoveDelayMs] pacing between the two AI seats in Jev vs Jev
   */
  constructor({
    id,
    mode,
    humanColor = "w",
    fen,
    timeControl = null,
    playerConfigs = {},
    jevClient,
    llmClient = null,
    modelName = "jev-latest",
    hasApiKey = false,
    aiMoveDelayMs = AI_MOVE_DELAY_MS,
  }) {
    this.id = id;
    this.mode = mode;
    this.humanColor = mode === "human-vs-jev" ? humanColor : null;
    this.createdAt = Date.now();
    this.jevClient = jevClient;
    this.llmClient = llmClient;
    // Per-seat strategist state: the plan in force, when it was made, what it cost and what went
    // wrong. Kept here rather than in the pipeline because a plan outlives a single move.
    this.planStates = { w: makePlanState(), b: makePlanState() };
    this.modelName = modelName;
    this.hasApiKey = hasApiKey;
    // Pacing between the two AI seats, so a person can watch the pieces move. Zero is
    // legitimate (tests, and a "fast forward" toggle), so it is clamped rather than defaulted.
    const requestedDelay = Number(aiMoveDelayMs);
    this.aiMoveDelayMs = Number.isFinite(requestedDelay) ? Math.min(5000, Math.max(0, Math.round(requestedDelay))) : AI_MOVE_DELAY_MS;

    this.chess = new Chess(fen && fen.trim() ? fen.trim() : undefined);
    this.startFen = this.chess.fen();
    this.history = [];
    this.listeners = new Set();
    this.ai = { thinking: false, side: null, startedAt: null, strategyName: null };
    this.drawOffer = null;
    this.lastError = null;
    this.forcedResult = null;
    this.autoplay = mode === "jev-vs-jev";
    this.aiRunToken = 0;

    this.players = {
      w: makePlayer("w", this.humanColor, playerConfigs.w),
      b: makePlayer("b", this.humanColor, playerConfigs.b),
    };

    this.clocks = timeControl
      ? {
          w: timeControl.initialMs,
          b: timeControl.initialMs,
          initialMs: timeControl.initialMs,
          incrementMs: timeControl.incrementMs ?? 0,
          running: null,
          updatedAt: Date.now(),
        }
      : null;

    this.evalBar = this.#computeEvalBar();
    this.clockTimer = null;
    this.#startClockForTurn();
    // If a Jev seat has the move (Jev vs Jev, or the human took Black), start it now.
    // Queued so the constructor returns before any request is made.
    queueMicrotask(() => this.kickAi());
  }

  // -------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event, payload) {
    for (const listener of this.listeners) {
      try {
        listener(event, payload);
      } catch {
        /* a broken listener must not stop the game */
      }
    }
  }

  #emitState() {
    this.emit("state", { game: this.snapshot() });
  }

  #notice(level, message) {
    this.emit("notice", { level, message });
  }

  // -------------------------------------------------------------------------
  // snapshot
  // -------------------------------------------------------------------------

  snapshot() {
    const turn = this.chess.turn();
    const board = this.chess.board().flat().map((cell) => (cell ? { square: cell.square, type: cell.type, color: cell.color } : null));
    const over = this.chess.isGameOver() || Boolean(this.forcedResult);
    const inCheck = this.chess.isCheck();
    const last = this.history[this.history.length - 1] ?? null;

    return {
      id: this.id,
      createdAt: this.createdAt,
      mode: this.mode,
      humanColor: this.humanColor,
      fen: this.chess.fen(),
      startFen: this.startFen,
      turn,
      moveNumber: this.chess.moveNumber?.() ?? 1,
      board,
      legalMoves: over
        ? []
        : this.chess.moves().map((move) => ({
            from: move.from,
            to: move.to,
            san: move.san,
            promotion: move.promotion ?? null,
            captured: move.captured ?? null,
            flags: typeof move.flags === "string" ? move.flags : "",
          })),
      lastMove: last ? { from: last.from, to: last.to, san: last.san } : null,
      check: { inCheck, square: inCheck ? this.#kingSquare(turn) : null },
      status: over
        ? this.forcedResult
          ? { over: true, result: this.forcedResult.result, reason: this.forcedResult.reason }
          : this.#endStatus()
        : { over: false, result: null, reason: null },
      history: this.history,
      players: {
        w: publicPlayer(this.players.w),
        b: publicPlayer(this.players.b),
      },
      clocks: this.clocks ? { ...this.clocks } : null,
      ai: { ...this.ai },
      autoplay: this.autoplay,
      drawOffer: this.drawOffer,
      evalBar: this.evalBar,
      jev: {
        hasApiKey: this.hasApiKey,
        mock: Boolean(this.jevClient?.mock),
        model: this.modelName,
        lastError: this.lastError,
      },
      llm: this.#llmSnapshot(),
    };
  }

  /**
   * What the UI needs to know about the strategy layer: whether it is configured, what it has
   * cost so far, and the plan each seat is currently playing under.
   */
  #llmSnapshot() {
    const white = this.planStates.w;
    const black = this.planStates.b;
    return {
      configured: Boolean(this.llmClient),
      provider: this.llmClient?.provider ?? null,
      model: this.llmClient?.model ?? null,
      mock: Boolean(this.llmClient?.mock),
      reviews: (white.reviews ?? 0) + (black.reviews ?? 0),
      costUsd: Math.round((((white.costUsd ?? 0) + (black.costUsd ?? 0))) * 1e6) / 1e6,
      tokens: (white.tokens ?? 0) + (black.tokens ?? 0),
      lastError: white.lastError ?? black.lastError ?? null,
      plans: { w: white.plan ?? null, b: black.plan ?? null },
    };
  }

  #kingSquare(color) {
    const cell = this.chess.board().flat().find((entry) => entry && entry.type === "k" && entry.color === color);
    return cell?.square ?? null;
  }

  #endStatus() {
    let reason = "unknown";
    if (this.chess.isCheckmate()) reason = "checkmate";
    else if (this.chess.isStalemate()) reason = "stalemate";
    else if (this.chess.isInsufficientMaterial()) reason = "insufficient material";
    else if (this.chess.isThreefoldRepetition()) reason = "threefold repetition";
    else if (this.chess.isFiftyMoveDraw()) reason = "fifty-move rule";
    const result = this.chess.result() ?? "*";
    return { over: true, result: result === "*" ? null : result, reason };
  }

  #computeEvalBar() {
    try {
      // Deliberately cheap: this runs after every move, including the human's, and a
      // slow bar would make the board feel laggy. A truncated search still yields the
      // one-ply ordering, which is enough to place the bar.
      const analysis = analyzeRoot(this.chess, { depth: 2, quiescence: 1, timeBudgetMs: 200, nodeBudget: 25_000 });
      const whiteCp = this.chess.turn() === "w" ? analysis.bestCp : -analysis.bestCp;
      const mate = analysis.moves[0]?.mateIn ?? null;
      const label =
        mate !== null && Math.abs(analysis.bestCp) > MATE_THRESHOLD
          ? `${analysis.bestCp > 0 ? "#" : "-#"}${Math.abs(mate)}`
          : `${whiteCp >= 0 ? "+" : "-"}${(Math.abs(whiteCp) / 100).toFixed(2)}`;
      return {
        cp: whiteCp,
        whiteWinProb: Number(cpToUnit(whiteCp, 220).toFixed(4)),
        source: "search",
        label,
      };
    } catch {
      return { cp: 0, whiteWinProb: 0.5, source: "search", label: "+0.00" };
    }
  }

  // -------------------------------------------------------------------------
  // clocks
  // -------------------------------------------------------------------------

  #startClockForTurn() {
    if (!this.clocks || this.chess.isGameOver()) {
      if (this.clocks) this.clocks.running = null;
      return;
    }
    this.clocks.running = this.chess.turn();
    this.clocks.updatedAt = Date.now();
    if (!this.clockTimer) {
      this.clockTimer = setInterval(() => this.#tickClock(), CLOCK_TICK_MS);
      this.clockTimer.unref?.();
    }
  }

  #tickClock() {
    if (!this.clocks || !this.clocks.running) return;
    const elapsed = Date.now() - this.clocks.updatedAt;
    if (this.clocks[this.clocks.running] - elapsed > 0) return;
    const flagged = this.clocks.running;
    this.clocks[flagged] = 0;
    this.clocks.running = null;
    this.#stopClock();
    this.#endByFlag(flagged);
  }

  #stopClock() {
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  #endByFlag(flagged) {
    const winner = flagged === "w" ? "b" : "w";
    this.forcedResult = { result: winner === "w" ? "1-0" : "0-1", reason: "timeout" };
    this.#notice("warn", `${flagged === "w" ? "White" : "Black"} ran out of time.`);
    this.#emitState();
    this.emit("game-over", { result: this.forcedResult.result, reason: "timeout" });
  }

  /** Deduct elapsed time, add the increment, then hand the clock to the other side. */
  #settleClockForMove(mover) {
    if (!this.clocks) return;
    const elapsed = this.clocks.running ? Math.max(0, Date.now() - this.clocks.updatedAt) : 0;
    if (this.clocks.running) this.clocks[this.clocks.running] = Math.max(0, this.clocks[this.clocks.running] - elapsed);
    this.clocks[mover] = Math.max(0, this.clocks[mover] + (this.clocks.incrementMs ?? 0));
  }

  // -------------------------------------------------------------------------
  // moves
  // -------------------------------------------------------------------------

  get isOver() {
    return this.chess.isGameOver() || Boolean(this.forcedResult);
  }

  #statusAfterMove() {
    if (this.forcedResult) return this.forcedResult;
    return this.#endStatus();
  }

  /**
   * Apply a move. `input` is either `{from,to,promotion}` or `{san}`.
   * @returns {{ok:true}|{ok:false,code:string,message:string}}
   */
  applyMove(input, { by, jev = null } = {}) {
    if (this.isOver) return { ok: false, code: "game-over", message: "This game is over. Start a new one to keep playing." };
    if (this.history.length >= MAX_PLIES) return { ok: false, code: "too-long", message: "Move limit reached." };

    const mover = this.chess.turn();
    const before = this.chess.fen();
    const applied = this.chess.move(input);
    if (!applied) {
      return { ok: false, code: "illegal-move", message: `"${typeof input === "string" ? input : `${input.from ?? "?"}-${input.to ?? "?"}`}" is not a legal move here.` };
    }

    this.#settleClockForMove(mover);
    this.drawOffer = null;

    const record = {
      ply: this.history.length + 1,
      moveNumber: Number(before.split(" ")[5] ?? 1),
      color: mover,
      san: applied.san,
      from: applied.from,
      to: applied.to,
      capture: applied.captured ?? null,
      check: this.chess.isCheck(),
      mate: this.chess.isCheckmate(),
      promotion: applied.promotion ?? null,
      castle: applied.flags?.includes?.("k") ? "kingside" : applied.flags?.includes?.("q") ? "queenside" : null,
      fenAfter: this.chess.fen(),
      at: Date.now(),
      clockMs: this.clocks ? this.clocks[mover] : null,
      by,
      jev: jev ?? null,
    };
    this.history.push(record);

    this.evalBar = this.#computeEvalBar();

    if (this.isOver) {
      this.#stopClock();
      if (this.clocks) this.clocks.running = null;
      const status = this.#statusAfterMove();
      this.#emitState();
      this.emit("game-over", { result: status.result, reason: status.reason });
    } else {
      this.#startClockForTurn();
      this.#emitState();
    }
    return { ok: true, record };
  }

  /** A human move (also used for "step" on a human seat in tests). */
  submitHumanMove(input, color = this.humanColor) {
    if (this.mode !== "human-vs-jev") {
      return { ok: false, code: "not-your-turn", message: "Both sides are Jev in this game." };
    }
    if (this.chess.turn() !== color) {
      return { ok: false, code: "not-your-turn", message: "It is not your turn." };
    }
    if (this.ai.thinking) return { ok: false, code: "not-your-turn", message: "Jev is still thinking." };
    const result = this.applyMove(input, { by: "human" });
    if (result.ok) this.kickAi();
    return result;
  }

  /** Undo back to the human's turn (one ply for Jev-vs-Jev while paused). */
  undo() {
    if (this.ai.thinking) return { ok: false, code: "not-your-turn", message: "Wait for Jev to finish its move." };
    if (this.mode === "jev-vs-jev" && this.autoplay) {
      return { ok: false, code: "not-your-turn", message: "Pause the game before taking a move back." };
    }
    if (this.history.length === 0) return { ok: false, code: "bad-request", message: "There are no moves to take back." };

    const pops = this.mode === "human-vs-jev" ? 2 : 1;
    for (let i = 0; i < pops && this.history.length > 0; i += 1) {
      this.history.pop();
      this.chess.undo();
    }
    this.forcedResult = null;
    this.drawOffer = null;
    this.lastError = null;
    this.evalBar = this.#computeEvalBar();
    this.#startClockForTurn();
    this.#emitState();
    if (this.mode === "human-vs-jev" && this.players[this.chess.turn()].kind === "jev") this.kickAi();
    return { ok: true };
  }

  resign(color) {
    if (this.isOver) return { ok: false, code: "game-over", message: "This game is already over." };
    const loser = color ?? this.chess.turn();
    this.forcedResult = { result: loser === "w" ? "0-1" : "1-0", reason: "resignation" };
    this.#stopClock();
    if (this.clocks) this.clocks.running = null;
    this.#notice("info", `${loser === "w" ? "White" : "Black"} resigned.`);
    this.#emitState();
    this.emit("game-over", { result: this.forcedResult.result, reason: "resignation" });
    return { ok: true };
  }

  /** Human offers a draw; a Jev opponent decides for itself, a human must accept. */
  async offerDraw(color) {
    if (this.isOver) return { ok: false, code: "game-over", message: "This game is already over." };
    const opponent = color === "w" ? "b" : "w";
    if (this.players[opponent].kind === "human") {
      this.drawOffer = color;
      this.#notice("info", `Draw offered. ${opponent === "w" ? "White" : "Black"}, accept or decline in the panel.`);
      this.#emitState();
      return { ok: true, pending: true };
    }

    this.#notice("info", `${this.players[opponent].name} is considering the draw offer…`);
    let accepted = false;
    let probability = null;
    try {
      const state = {
        game: "chess",
        task: `Decide whether ${this.players[opponent].name} should accept a draw offer.`,
        position: {
          fen: this.chess.fen(),
          side_to_move: this.chess.turn() === "w" ? "White" : "Black",
          board_8_to_1: this.chess.ascii?.() ?? "",
          material_balance: this.evalBar.label,
        },
        draw_offer_from: color === "w" ? "White" : "Black",
        offer_context: `${this.players[opponent].name}'s own assessment of the position is ${this.evalBar.label} ` +
          `(${this.evalBar.whiteWinProb > 0.5 ? "White" : "Black"} is favoured by the shallow search).`,
      };
      const response = await this.jevClient.systemOne({
        state,
        questions: {
          accept_draw: noul(
            `Should ${this.players[opponent].name} accept a draw offer in this position instead of continuing to play?`,
            {
              true: `${this.players[opponent].name} is not better and a draw is a fair result`,
              false: `${this.players[opponent].name} has good chances and should keep playing`,
            },
          ),
        },
      });
      probability = readNoulAnswer(response.answers?.accept_draw);
      accepted = probability !== null && probability >= 0.5;
    } catch (error) {
      this.lastError = error.message;
      this.#notice("warn", `Jev could not rule on the draw offer (${error.message}), so it is declined.`);
      accepted = false;
    }

    if (accepted) {
      this.forcedResult = { result: "1/2-1/2", reason: "agreed draw" };
      this.#stopClock();
      if (this.clocks) this.clocks.running = null;
      this.#notice("info", `${this.players[opponent].name} accepted the draw.`);
      this.#emitState();
      this.emit("game-over", { result: "1/2-1/2", reason: "agreed draw" });
    } else {
      this.#notice("info", `${this.players[opponent].name} declined the draw${probability === null ? "" : ` (acceptance ${probability.toFixed(2)})`}.`);
    }
    return { ok: true, accepted, probability };
  }

  acceptDraw(color) {
    if (this.drawOffer === null) return { ok: false, code: "bad-request", message: "There is no draw offer to accept." };
    if (this.drawOffer === color) return { ok: false, code: "bad-request", message: "You cannot accept your own draw offer." };
    this.forcedResult = { result: "1/2-1/2", reason: "agreed draw" };
    this.drawOffer = null;
    this.#stopClock();
    if (this.clocks) this.clocks.running = null;
    this.#emitState();
    this.emit("game-over", { result: "1/2-1/2", reason: "agreed draw" });
    return { ok: true };
  }

  declineDraw(color) {
    if (this.drawOffer === null) return { ok: false, code: "bad-request", message: "There is no draw offer to decline." };
    if (this.drawOffer === color) return { ok: false, code: "bad-request", message: "You cannot decline your own draw offer." };
    this.drawOffer = null;
    this.#notice("info", "Draw offer declined.");
    this.#emitState();
    return { ok: true };
  }

  setPlayer(color, config) {
    const current = this.players[color];
    if (!current || current.kind === "human") {
      return { ok: false, code: "bad-request", message: `The ${color === "w" ? "white" : "black"} seat is played by a human.` };
    }
    this.players[color] = makePlayer(color, this.humanColor, config, current);
    this.#notice("info", `${color === "w" ? "White" : "Black"} is now ${this.players[color].name}.`);
    this.#emitState();
    return { ok: true };
  }

  setAutoplay(running) {
    if (this.mode !== "jev-vs-jev") return { ok: false, code: "bad-request", message: "Only a Jev-vs-Jev game can be paused." };
    this.autoplay = Boolean(running);
    if (this.autoplay) {
      this.#notice("info", "Jev vs Jev resumed.");
      this.kickAi();
    } else {
      this.#notice("info", "Jev vs Jev paused. Use Step to play a single move.");
    }
    this.#emitState();
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // AI turn
  // -------------------------------------------------------------------------

  /** Start an AI move if it is an AI seat's turn. Safe to call repeatedly. */
  kickAi() {
    if (this.ai.thinking || this.isOver) return;
    const turn = this.chess.turn();
    const player = this.players[turn];
    if (player.kind !== "jev") return;
    if (this.mode === "jev-vs-jev" && !this.autoplay) return;
    const token = ++this.aiRunToken;
    this.#runAiTurn(token).catch((error) => {
      this.lastError = error?.message ?? String(error);
      this.ai = { thinking: false, side: null, startedAt: null, strategyName: null };
      this.#notice("error", `Jev could not move: ${this.lastError}`);
      this.#emitState();
    });
  }

  /**
   * The strategy for one AI turn, consulting the strategist when this seat plans.
   *
   * The plan is reviewed at a trigger, not every move — see `shouldReview` — and whatever happens
   * the returned strategy is playable: if the strategist fails or answers nonsense, the plan in
   * force (or the bare preset) stands and the failure is recorded rather than thrown.
   */
  async #resolveStrategyForTurn(turn, player) {
    const base = player.strategy;
    const state = this.planStates[turn];
    if (!base?.llmPlan) return { strategy: base, reviewed: false };
    if (!this.llmClient) {
      const error = "the strategist is not configured (no Gemini key)";
      state.lastError = error;
      // Recorded on the strategy so the move record carries the reason instead of silence.
      state.meta = { ...(state.meta ?? {}), error, mock: false, model: null, api: null };
      return { strategy: applyCachedPlan(base, state), reviewed: false };
    }

    const lastJev = [...this.history].reverse().find((entry) => entry.jev?.assessment?.labels);
    const labels = lastJev?.jev?.assessment?.labels ?? null;
    const lastMove = this.history[this.history.length - 1] ?? null;
    const pliesSinceReview = this.history.length - (state.reviewedAtPly ?? 0);
    const targetTouched = Boolean(state.plan && lastMove && state.plan.targets?.includes(lastMove.to));
    const evalCp = typeof this.evalBar?.cp === "number" ? this.evalBar.cp : null;
    // Code's phase, not Jev's: a per-position judgement flips around and would fire a review every
    // move (that bug cost 83 reviews in 89 plies before it was caught).
    const phase = phaseForPosition(this.chess);

    const { review, reason, thinkingLevel } = shouldReview({
      plan: state.plan,
      pliesSinceReview,
      phase,
      planPhase: state.planPhase,
      evalCp,
      planEvalCp: state.planEvalCp,
      targetTouched,
    });

    if (!review) return { strategy: applyCachedPlan(base, state), reviewed: false };

    const result = await reviewPlan({
      llmClient: this.llmClient,
      chess: this.chess,
      baseStrategy: base,
      currentPlan: state.plan,
      pliesSinceReview,
      evalCp,
      evalLabel: this.evalBar?.label ?? null,
      phase,
      lastMoves: this.history.map((entry) => entry.san),
      opponentLastMove: lastMove ? { san: lastMove.san, from: lastMove.from, to: lastMove.to, color: lastMove.color } : null,
      jevRead: labels,
      thinkingLevel,
      reason,
    });

    state.reviews += 1;
    state.lastReason = reason;
    state.lastReviewAt = Date.now();
    if (typeof result.costUsd === "number") state.costUsd = (state.costUsd ?? 0) + result.costUsd;
    if (result.usage) state.tokens = (state.tokens ?? 0) + (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);

    if (result.ok) {
      state.plan = result.plan;
      // Code's phase, matching what the trigger compares against — storing Jev's read here was
      // the bug that made every move look like a phase change.
      state.planPhase = phase;
      state.planEvalCp = evalCp;
      state.reviewedAtPly = this.history.length;
      state.lastError = null;
      state.meta = planMetaFrom(result, { state, pliesSinceReview, applied: result.applied });
      this.#notice("info", `Plan: ${describePlan(result.plan)}${result.plan.commentary ? ` — ${result.plan.commentary}` : ""}`);
    } else {
      state.lastError = result.error ?? "the strategist failed";
      state.meta = planMetaFrom(result, { state, pliesSinceReview, applied: state.applied });
      this.#notice("warn", `Strategist unavailable (${state.lastError}); continuing on the plan in force.`);
    }

    return { strategy: applyCachedPlan(base, state), reviewed: true, result };
  }

  async #runAiTurn(token) {
    const turn = this.chess.turn();
    const player = this.players[turn];

    if (this.mode === "jev-vs-jev" && this.aiMoveDelayMs > 0) await sleep(this.aiMoveDelayMs);

    this.ai = { thinking: true, side: turn, startedAt: Date.now(), strategyName: player.name };
    this.emit("ai-thinking", { side: turn, playerName: player.name, strategyName: player.name, startedAt: this.ai.startedAt });
    this.#emitState();

    // A strategy that plans asks the strategist before Jev judges the candidates. The plan is
    // reviewed only at a trigger (see shouldReview), so most moves reuse the plan in force.
    const { strategy: activeStrategy } = await this.#resolveStrategyForTurn(turn, player);

    let move = null;
    let record = null;
    try {
      const result = await selectMove({
        chess: this.chess,
        strategy: activeStrategy,
        jevClient: this.jevClient,
        lastMovesSan: this.history.map((entry) => entry.san),
        onEvent: (event) => {
          if (event?.message) this.emit("notice", { level: "info", message: `${player.name}: ${event.message}` });
        },
      });
      move = result.move;
      record = result.record;
      if (record?.errors?.length) this.lastError = record.errors.join(" ");
    } catch (error) {
      this.lastError = error?.message ?? String(error);
    }

    this.ai = { thinking: false, side: null, startedAt: null, strategyName: null };
    if (token !== this.aiRunToken) return; // superseded by an undo or a new game

    if (!move) {
      if (!this.isOver) {
        this.#notice("error", `${player.name} could not produce a move${this.lastError ? `: ${this.lastError}` : ""}. Choosing the first legal move instead.`);
        const fallback = this.chess.moves()[0];
        if (!fallback) {
          this.#emitState();
          return;
        }
        this.applyMove(fallback, { by: "jev", jev: null });
      } else {
        this.#emitState();
      }
    } else {
      const applied = this.applyMove(move, { by: "jev", jev: record });
      if (!applied.ok) {
        this.#notice("error", `${player.name} produced a move the rules rejected (${applied.message}); a legal move played instead.`);
        const fallback = this.chess.moves()[0];
        if (fallback) this.applyMove(fallback, { by: "jev", jev: record });
      } else {
        this.emit("ai-result", { side: turn, move: this.history[this.history.length - 1], elapsedMs: record?.elapsedMs ?? null });
      }
    }

    if (this.mode === "jev-vs-jev" && this.autoplay) this.kickAi();
  }

  dispose() {
    this.#stopClock();
    this.listeners.clear();
    this.aiRunToken += 1;
  }
}

// ---------------------------------------------------------------------------

function makePlayer(color, humanColor, config = {}, previous = null) {
  const kind = humanColor && color === humanColor ? "human" : "jev";
  if (kind === "human") {
    return { kind: "human", color, name: "You", strategy: null, strategyId: null, pipeline: null, weights: null };
  }
  const strategyId = config?.strategyId ?? previous?.strategyId ?? DEFAULT_STRATEGY_ID;
  // `timeBudgetMs` must be forwarded: without it, a caller asking for a fast game silently
  // got the preset's 1.4 s search budget instead (found by tests/soak.test.mjs).
  const strategy = resolveStrategy({
    strategyId,
    weights: config?.weights ?? previous?.weights,
    timeBudgetMs: config?.timeBudgetMs ?? previous?.timeBudgetMs,
  });
  return {
    kind: "jev",
    color,
    name: strategy.name,
    strategy,
    strategyId: strategy.id,
    pipeline: strategy.pipeline,
    pipelineName: PIPELINES[strategy.pipeline]?.name ?? strategy.pipeline,
    weights: strategy.weights,
  };
}

function publicPlayer(player) {
  if (player.kind === "human") return { kind: "human", name: "You", strategyId: null, pipeline: null, weights: null };
  return {
    kind: "jev",
    name: player.name,
    strategyId: player.strategyId,
    strategyDescription: player.strategy?.description ?? null,
    pipeline: player.pipeline,
    pipelineName: player.pipelineName,
    weights: player.weights,
    candidateLimit: player.strategy?.candidateLimit ?? null,
    searchDepth: player.strategy?.searchDepth ?? null,
    usesStrategist: Boolean(player.strategy?.llmPlan),
    strategyName: player.strategy?.name ?? null,
  };
}

/** Fresh strategist state for one seat. */
function makePlanState() {
  return {
    plan: null,
    meta: null,
    applied: null,
    planPhase: null,
    planEvalCp: null,
    reviewedAtPly: 0,
    reviews: 0,
    costUsd: 0,
    tokens: 0,
    lastError: null,
    lastReason: null,
    lastReviewAt: null,
  };
}

/**
 * Re-apply the plan in force to the bare preset. Cheap and pure, and done on every planned move
 * because `player.strategy` stays untouched: the preset is the base, the plan is a layer.
 */
function applyCachedPlan(base, state) {
  if (!state.plan) {
    return state.lastError ? { ...base, planMeta: state.meta ?? { error: state.lastError } } : base;
  }
  const { strategy, applied } = applyPlan(base, state.plan);
  return { ...strategy, planMeta: state.meta ? { ...state.meta, applied } : null };
}

/** Shape a strategist result for the move record, whether it succeeded or not. */
function planMetaFrom(result, { state, pliesSinceReview, applied }) {
  return {
    promptVersion: result.promptVersion,
    reason: result.reason,
    thinkingLevel: result.thinkingLevel,
    model: result.model,
    api: result.api,
    mock: result.mock,
    usage: result.usage,
    costUsd: result.costUsd,
    elapsedMs: result.elapsedMs,
    problems: result.problems ?? [],
    warnings: result.warnings ?? [],
    notes: result.notes ?? [],
    reviewedAtPly: state.reviewedAtPly,
    pliesSinceReview,
    applied: applied ?? null,
    error: result.ok ? null : result.error ?? null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
