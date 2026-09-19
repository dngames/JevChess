/**
 * app.js — the app shell: store, event wiring, dialogs, keyboard shortcuts.
 *
 * Everything authoritative comes from the server over `/api/games/:id` + SSE.
 * This file owns the one piece of derived state the UI needs (the read-only
 * history preview), dispatches every action, and keeps the panels in sync.
 */

import { JevChessApi, ApiError, toneForErrorCode } from "./api.js";
import { Board, canInteract } from "./board.js";
import {
  asText,
  clamp,
  dimensionLabel,
  latestJevRecord,
  pgnFromGame,
  positionPreviewFromHistory,
  turnFromFen,
} from "./logic.js";
import {
  clockContext,
  createBanner,
  createEvalBar,
  createElement,
  createJevPanel,
  createMoveList,
  createPlayerCard,
  createStatusLine,
  createToasts,
} from "./panels.js";

const api = new JevChessApi("");

const IDLE_THINKING = { active: false, startedAt: null, side: null, strategyName: null };

const store = {
  /** last GameState from the server; null until the first game exists */
  game: null,
  /** "live" | "preview" */
  mode: "live",
  /** synthetic position for a history/candidate preview (mode === "preview") */
  preview: null,
  /** number of history plies applied to build `preview` */
  previewPly: null,
  /** arrow overlay for a hovered/clicked judgment-panel candidate */
  previewCandidate: null,
  health: null,
  connection: "idle", // idle | connecting | open | reconnecting | unsupported
  serverOffset: 0,
  lastServerTime: 0,
  flipped: false,
  threatOn: false,
  thinking: { ...IDLE_THINKING },
  /** true once the user picked a ply; stops auto-following the newest Jev move */
  userPickedJev: false,
  selectedJevPly: null,
  strategies: { presets: [], sliders: [], pipelines: [] },
  busy: false,
};

let unsubscribe = null;
let streamGameId = null;

/* ------------------------------------------------------------------ dom */

const dom = {
  boardHost: document.getElementById("board-host"),
  boardHint: document.getElementById("board-hint"),
  evalBar: document.getElementById("eval-bar"),
  jevPanel: document.getElementById("jev-panel"),
  moveList: document.getElementById("move-list"),
  statusLine: document.getElementById("status-line"),
  banner: document.getElementById("jev-banner"),
  toasts: document.getElementById("toast-stack"),
  playerTop: document.getElementById("player-top"),
  playerBottom: document.getElementById("player-bottom"),
  connectionNote: document.getElementById("connection-note"),
  dialog: document.getElementById("new-game-dialog"),
  dialogForm: document.getElementById("new-game-form"),
  dialogError: document.getElementById("dialog-error"),
  dialogStart: document.getElementById("dialog-start"),
  strategiesStatus: document.getElementById("strategies-status"),
  playersGrid: document.getElementById("players-grid"),
  playerTemplate: document.getElementById("player-config-template"),
  timeControl: document.getElementById("time-control"),
  customClock: document.getElementById("custom-clock"),
  timeInitial: document.getElementById("time-initial"),
  timeIncrement: document.getElementById("time-increment"),
  fenInput: document.getElementById("fen-input"),
  colorField: document.getElementById("color-field"),
  btnNew: document.getElementById("btn-new"),
  btnUndo: document.getElementById("btn-undo"),
  btnFlip: document.getElementById("btn-flip"),
  btnResign: document.getElementById("btn-resign"),
  btnDraw: document.getElementById("btn-draw"),
  btnDrawAccept: document.getElementById("btn-draw-accept"),
  btnDrawDecline: document.getElementById("btn-draw-decline"),
  btnPause: document.getElementById("btn-pause"),
  btnStep: document.getElementById("btn-step"),
  btnArrows: document.getElementById("btn-arrows"),
  btnCopyFen: document.getElementById("btn-copy-fen"),
  btnLoadFen: document.getElementById("btn-load-fen"),
  btnCopyPgn: document.getElementById("btn-copy-pgn"),
  btnDownloadPgn: document.getElementById("btn-download-pgn"),
};

const evalBar = createEvalBar(dom.evalBar);
const jevPanel = createJevPanel(dom.jevPanel);
const moveList = createMoveList(dom.moveList);
const statusLine = createStatusLine(dom.statusLine);
const banner = createBanner(dom.banner);
const toasts = createToasts(dom.toasts);
const playerCards = {
  top: createPlayerCard(dom.playerTop),
  bottom: createPlayerCard(dom.playerBottom),
};

/** @type {Board|null} */
let board = null;

/* --------------------------------------------------------------- helpers */

function toast(level, message) {
  toasts.push(level, message);
}

function reportError(error) {
  if (!error) return;
  if (error instanceof ApiError) {
    toast(toneForErrorCode(error.code), error.message);
    return;
  }
  toast("error", error && error.message ? error.message : String(error));
}

function localNow() {
  return Date.now();
}

function noteServerTime(serverTime) {
  const value = Number(serverTime);
  if (!Number.isFinite(value) || value <= 0) return;
  store.serverOffset = value - localNow();
  store.lastServerTime = value;
}

/** The position the board should display right now. */
function currentPosition() {
  if (store.mode === "preview" && store.preview) return store.preview;
  const game = store.game;
  return {
    board: game ? game.board : null,
    lastMove: game ? game.lastMove : null,
    check: game ? game.check : null,
    turn: game ? game.turn : "w",
  };
}

function boardState() {
  const game = store.game;
  const position = currentPosition();
  const previewMode = store.mode === "preview";
  const check = previewMode
    ? { inCheck: false, square: null }
    : game && game.check && typeof game.check === "object"
      ? game.check
      : { inCheck: false, square: null };
  return {
    game,
    mode: store.mode,
    board: position.board,
    lastMove: position.lastMove,
    check,
    legalMoves: previewMode ? [] : game && Array.isArray(game.legalMoves) ? game.legalMoves : [],
    threatOn: store.threatOn,
  };
}

/** How many plies of history the live board is showing. */
function historyLength() {
  const game = store.game;
  return game && Array.isArray(game.history) ? game.history.length : 0;
}

function selectedJevRecord() {
  const game = store.game;
  if (!game || !Array.isArray(game.history)) return null;
  if (store.selectedJevPly !== null) {
    const found = game.history.find((record) => Number(record && record.ply) === store.selectedJevPly);
    if (found && found.jev) return found;
  }
  return latestJevRecord(game.history);
}

function setConnection(status) {
  store.connection = status;
  if (dom.connectionNote) dom.connectionNote.hidden = status !== "reconnecting";
  renderBoardHint();
}

/* ----------------------------------------------------------------- render */

function playerEntries() {
  const boardSide = store.flipped ? "b" : "w";
  return boardSide === "b"
    ? [
        { color: "b", card: playerCards.top },
        { color: "w", card: playerCards.bottom },
      ]
    : [
        { color: "w", card: playerCards.bottom },
        { color: "b", card: playerCards.top },
      ];
}

function renderPlayers(now) {
  const game = store.game;
  const players = game && game.players && typeof game.players === "object" ? game.players : {};
  const clocks = clockContext(game, now, store.serverOffset);
  const over = !!(game && game.status && game.status.over);
  for (const entry of playerEntries()) {
    entry.card.update(players[entry.color] || null, entry.color, {
      remainingMs: clocks[entry.color],
      running: clocks.running === entry.color,
      active: !!game && game.turn === entry.color && !over,
      thinking: store.thinking.active && store.thinking.side === entry.color,
    });
  }
}

function render() {
  const game = store.game;
  const now = localNow();

  renderPlayers(now);
  statusLine.update(game, now);
  evalBar.update(game ? game.evalBar : null);
  banner.update(game);
  moveList.update(game ? game.history : [], {
    currentPly: historyLength(),
    previewPly: store.mode === "preview" ? store.previewPly : null,
  });
  jevPanel.update(selectedJevRecord(), game);

  board.render(boardState());
  // The candidate overlay is its own layer: re-apply it after the board diff so a
  // state update never wipes a preview the user is looking at.
  if (store.previewCandidate) board.previewCandidate(store.previewCandidate);

  renderControls();
  renderBoardHint();
}

function renderControls() {
  const game = store.game;
  const over = !!(game && game.status && game.status.over);
  const isJevVsJev = !!game && game.mode === "jev-vs-jev";
  const humanVsJev = !!game && game.mode === "human-vs-jev";
  const drawOffer = game && typeof game.drawOffer === "string" ? game.drawOffer : null;
  const humanColor = game && (game.humanColor === "w" || game.humanColor === "b") ? game.humanColor : null;
  const offeredByMe = !!drawOffer && !!humanColor && drawOffer === humanColor;
  const offeredByOther = !!drawOffer && drawOffer !== humanColor;

  dom.btnUndo.disabled = store.busy || !game || historyLength() === 0;
  dom.btnResign.disabled = store.busy || over || !game || isJevVsJev;
  dom.btnDraw.hidden = !humanVsJev;
  dom.btnDraw.disabled = store.busy || over || offeredByMe;
  dom.btnDraw.textContent = offeredByMe ? "Draw offered…" : "Offer draw";
  dom.btnDrawAccept.hidden = !offeredByOther;
  dom.btnDrawAccept.disabled = store.busy || over;
  dom.btnDrawDecline.hidden = !offeredByOther;
  dom.btnDrawDecline.disabled = store.busy || over;
  dom.btnPause.hidden = !isJevVsJev;
  dom.btnStep.hidden = !isJevVsJev;
  const running = !!(game && game.autoplay);
  dom.btnPause.textContent = running ? "Pause" : "Resume";
  dom.btnPause.disabled = store.busy || !game || over;
  dom.btnStep.disabled = store.busy || running || !game || over;
  dom.btnArrows.setAttribute("aria-pressed", store.threatOn ? "true" : "false");
  dom.btnArrows.classList.toggle("is-on", store.threatOn);
  dom.btnCopyFen.disabled = !game;
  dom.btnCopyPgn.disabled = !game;
  dom.btnDownloadPgn.disabled = !game;
}

function renderBoardHint() {
  const game = store.game;
  const bits = [];
  if (store.connection === "reconnecting") bits.push("Reconnecting to the server…");
  if (store.mode === "preview") {
    bits.push(
      store.previewCandidate
        ? `Previewing ${store.previewCandidate.san || "a candidate move"} — read-only.`
        : `Viewing history at ply ${store.previewPly} of ${historyLength()} — read-only.`,
    );
  } else if (!game) {
    bits.push("Starting…");
  } else if (game.status && game.status.over) {
    bits.push(
      `Game over: ${asText(game.status.result, "?")}${game.status.reason ? ` (${game.status.reason})` : ""}`,
    );
  } else if (canInteract({ game, mode: store.mode })) {
    bits.push("Your move — drag a piece, or click origin then destination.");
  } else if (game.mode === "jev-vs-jev") {
    bits.push(game.autoplay ? "Jev vs Jev is running." : "Jev vs Jev is paused — use Step.");
  } else {
    bits.push("Waiting for Jev…");
  }
  const fen = game && typeof game.fen === "string" ? game.fen : "";
  if (fen && store.mode === "live") bits.push(fen);
  dom.boardHint.textContent = bits.join("  ·  ");
}

/* -------------------------------------------------------------- previews */

/** Show the position after `ply` plies of history; null returns to the live game. */
function previewPly(ply) {
  const game = store.game;
  if (!game || !Array.isArray(game.history)) return;
  if (ply === null || ply === undefined) {
    returnToLive();
    return;
  }
  const wanted = Number(ply);
  const clamped = Math.max(0, Math.min(game.history.length, Number.isFinite(wanted) ? Math.floor(wanted) : 0));
  store.mode = "preview";
  store.previewPly = clamped;
  store.preview = positionPreviewFromHistory(game.history, clamped);
  store.previewCandidate = null;
  store.userPickedJev = true;
  store.selectedJevPly = clamped > 0 ? clamped : null;
  if (board) {
    board.setSelected(null);
    board.clearPreview();
  }
  render();
}

function returnToLive() {
  store.mode = "live";
  store.previewPly = null;
  store.preview = null;
  store.previewCandidate = null;
  store.userPickedJev = false;
  store.selectedJevPly = null;
  if (board) board.clearPreview();
  render();
}

/**
 * Overlay a candidate's origin/destination on the board without playing it.
 * `null` clears the overlay and, when we were only previewing a candidate,
 * returns to the live position.
 */
function previewCandidateMove(move) {
  if (!move || !asText(move.from) || !asText(move.to)) {
    const candidateOnly = store.mode === "preview" && store.previewCandidate !== null && !store.userPickedJev;
    store.previewCandidate = null;
    if (board) board.clearPreview();
    if (candidateOnly) returnToLive();
    else renderBoardHint();
    return;
  }
  const game = store.game;
  if (!game) return;
  // Only reposition the board when it is showing the live game. If the user is
  // already looking at a history ply (or at another candidate), keep that
  // position and treat the candidate as an arrow overlay on top of it.
  if (store.mode === "live") {
    const before = positionPreviewFromHistory(game.history, Math.max(0, game.history.length - 1));
    store.mode = "preview";
    store.preview = before;
    store.previewPly = before.ply;
  }
  store.previewCandidate = { from: asText(move.from), to: asText(move.to), san: asText(move.san) };
  render();
}

/* ------------------------------------------------------------- streaming */

function stopStream() {
  if (typeof unsubscribe === "function") unsubscribe();
  unsubscribe = null;
  streamGameId = null;
}

function startStream(gameId) {
  if (!gameId) return;
  if (streamGameId === gameId && typeof unsubscribe === "function") return;
  stopStream();
  streamGameId = gameId;
  setConnection("connecting");

  unsubscribe = api.subscribe(gameId, {
    open: (serverTime, info) => {
      noteServerTime(serverTime);
      setConnection("open");
      // A reconnect may have missed changes: re-fetch the authoritative snapshot.
      if (info && info.first === false) {
        refreshGame().catch(() => {});
      }
    },
    error: () => setConnection("reconnecting"),
    unsupported: () => {
      setConnection("reconnecting");
      toast("warn", "This browser cannot stream live updates; reload to resync.");
    },
    state: (serverTime, game) => {
      noteServerTime(serverTime);
      if (store.connection !== "open") setConnection("open");
      applySnapshot(game);
    },
    "ai-thinking": (serverTime, payload) => {
      noteServerTime(serverTime);
      store.thinking = {
        active: true,
        startedAt: Number.isFinite(Number(payload.startedAt)) ? Number(payload.startedAt) : serverTime,
        side: payload.side === "b" ? "b" : payload.side === "w" ? "w" : null,
        strategyName: asText(payload.strategyName),
      };
      render();
    },
    "ai-result": (serverTime, payload) => {
      noteServerTime(serverTime);
      store.thinking = { ...IDLE_THINKING };
      const move = payload && payload.move ? payload.move : null;
      if (move) {
        const ms = Number(payload.elapsedMs);
        toast(
          "info",
          `Jev played ${asText(move.san, "?")}${Number.isFinite(ms) ? ` (${(ms / 1000).toFixed(1)}s)` : ""}.`,
        );
        if (store.mode === "live" && Number.isFinite(Number(move.ply))) {
          store.selectedJevPly = Number(move.ply);
          store.userPickedJev = false;
        }
      }
      render();
    },
    notice: (serverTime, payload) => {
      noteServerTime(serverTime);
      const level = payload.level === "warn" || payload.level === "error" ? payload.level : "info";
      toast(level, asText(payload.message, "Notice"));
    },
    "game-over": (serverTime, payload) => {
      noteServerTime(serverTime);
      store.thinking = { ...IDLE_THINKING };
      const reason = payload && payload.reason ? ` (${payload.reason})` : "";
      toast("info", `Game over: ${asText(payload && payload.result, "?")}${reason}`);
      render();
    },
  });
}

function applySnapshot(game) {
  if (!game || typeof game !== "object") return;
  store.game = game;
  store.busy = false;

  const ai = game.ai && typeof game.ai === "object" ? game.ai : null;
  const status = game.status && typeof game.status === "object" ? game.status : {};
  if (status.over === true) {
    store.thinking = { ...IDLE_THINKING };
  } else if (ai && ai.thinking === true) {
    if (!store.thinking.active) {
      store.thinking = {
        active: true,
        startedAt: Number.isFinite(Number(ai.startedAt)) ? Number(ai.startedAt) : localNow() + store.serverOffset,
        side: ai.side === "b" ? "b" : ai.side === "w" ? "w" : null,
        strategyName: asText(ai.strategyName),
      };
    }
  } else {
    store.thinking = { ...IDLE_THINKING };
  }

  // A snapshot that runs past the ply we are inspecting invalidates the preview.
  if (store.mode === "preview" && store.previewPly !== null && store.previewPly > historyLength()) {
    returnToLive();
  }
  if (board) board.cancelPendingInput();
  if (store.mode === "live" && !store.userPickedJev) {
    const record = latestJevRecord(game.history);
    if (record && Number.isFinite(Number(record.ply))) store.selectedJevPly = Number(record.ply);
  }
  render();
}

async function refreshGame() {
  const id = store.game && store.game.id;
  if (!id) return;
  const payload = await api.getGame(id);
  if (payload && payload.game) applySnapshot(payload.game);
}

/* --------------------------------------------------------------- actions */

async function createDefaultGame() {
  // `players[color]` is a PlayerConfig ({ strategyId, weights }): the server
  // decides human-vs-Jev from `humanColor`, so the human seat needs no config.
  const payload = await api.createGame({
    mode: "human-vs-jev",
    humanColor: "w",
    timeControl: { initialMs: 180000, incrementMs: 2000 },
    players: { b: {} },
  });
  if (!payload || !payload.game) return null;
  store.flipped = payload.game.humanColor === "b";
  if (board) board.setOrientation(store.flipped ? "b" : "w");
  applySnapshot(payload.game);
  startStream(payload.game.id);
  return payload.game.id;
}

async function withBusy(fn) {
  if (store.busy) return;
  store.busy = true;
  renderControls();
  try {
    await fn();
  } catch (error) {
    reportError(error);
  } finally {
    store.busy = false;
    renderControls();
  }
}

function sendMove(move) {
  const game = store.game;
  if (!game || !move) return;
  withBusy(async () => {
    const payload = await api.playMove(game.id, move);
    if (payload && payload.game) applySnapshot(payload.game);
  });
}

function undo() {
  const game = store.game;
  if (!game) return;
  if (store.mode === "preview") {
    returnToLive();
    return;
  }
  withBusy(async () => {
    const payload = await api.undo(game.id);
    if (payload && payload.game) applySnapshot(payload.game);
  });
}

async function resign() {
  const game = store.game;
  if (!game) return;
  const color = game.humanColor === "b" ? "b" : "w";
  if (typeof window.confirm === "function" && !window.confirm("Resign this game?")) return;
  await withBusy(async () => {
    const payload = await api.resign(game.id, color);
    if (payload && payload.game) applySnapshot(payload.game);
  });
}

async function draw(action) {
  const game = store.game;
  if (!game) return;
  await withBusy(async () => {
    const payload = await api.draw(game.id, action);
    if (payload && payload.game) applySnapshot(payload.game);
    toast(
      "info",
      action === "offer" ? "Draw offered." : action === "accept" ? "Draw accepted." : "Draw declined.",
    );
  });
}

function toggleAutoplay() {
  const game = store.game;
  if (!game) return;
  withBusy(async () => {
    const payload = await api.autoplay(game.id, !game.autoplay);
    if (payload && payload.game) applySnapshot(payload.game);
  });
}

function step() {
  const game = store.game;
  if (!game) return;
  withBusy(async () => {
    const payload = await api.step(game.id);
    if (payload && payload.game) applySnapshot(payload.game);
  });
}

/* ------------------------------------------------------------ clipboard */

async function copyText(text, what) {
  const value = typeof text === "string" ? text : "";
  if (!value) {
    toast("warn", `Nothing to copy for ${what}.`);
    return;
  }
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
    } else {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "readonly");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    toast("info", `${what} copied.`);
  } catch {
    toast("warn", `Could not copy ${what}.`);
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pgnText() {
  return store.game ? pgnFromGame(store.game) : "";
}

function slug(value) {
  const text = asText(value, "game");
  return text.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "game";
}

/* ------------------------------------------------------- new game dialog */

const playerConfigState = {
  w: { strategyId: null, weights: {} },
  b: { strategyId: null, weights: {} },
};

function presetById(id) {
  return store.strategies.presets.find((preset) => preset && preset.id === id) || null;
}

function defaultPreset() {
  const presets = store.strategies.presets;
  if (!presets.length) return null;
  return presets.find((preset) => preset && preset.best) || presets[0];
}

function presetWeights(id) {
  const preset = presetById(id) || defaultPreset();
  return preset && preset.weights && typeof preset.weights === "object" ? { ...preset.weights } : {};
}

function selectedMode() {
  const checked = dom.dialogForm.querySelector('input[name="mode"]:checked');
  return checked && checked.value === "jev-vs-jev" ? "jev-vs-jev" : "human-vs-jev";
}

function selectedHumanColor() {
  const checked = dom.dialogForm.querySelector('input[name="humanColor"]:checked');
  return checked && checked.value === "b" ? "b" : "w";
}

function buildPlayerCards() {
  dom.playersGrid.replaceChildren();
  const template = dom.playerTemplate;
  if (!template || !template.content) return;
  const mode = selectedMode();
  const humanColor = selectedHumanColor();

  for (const side of ["w", "b"]) {
    const fragment = template.content.cloneNode(true);
    const node = fragment.querySelector(".player-config");
    node.dataset.side = side;
    const title = node.querySelector('[data-role="title"]');
    const kind = node.querySelector('[data-role="kind"]');
    const select = node.querySelector('[data-role="strategy"]');
    const description = node.querySelector('[data-role="description"]');
    const presetMeta = node.querySelector('[data-role="preset-meta"]');
    const weightsBox = node.querySelector('[data-role="weights"]');
    const strategyLabel = node.querySelector('[data-role="strategy-label"]');
    const isHuman = mode === "human-vs-jev" && side === humanColor;

    title.textContent = side === "w" ? "White" : "Black";
    kind.textContent = isHuman ? "You" : "Jev";
    kind.className = `player-config-kind player-config-kind-${isHuman ? "human" : "jev"}`;
    select.id = `strategy-${side}`;
    strategyLabel.setAttribute("for", select.id);
    node.classList.toggle("is-human", isHuman);

    select.replaceChildren();
    for (const preset of store.strategies.presets) {
      const option = document.createElement("option");
      option.value = asText(preset.id, "");
      option.textContent = asText(preset.name, asText(preset.id, "Strategy"));
      select.appendChild(option);
    }
    const state = playerConfigState[side];
    if (state.strategyId === null) {
      const preset = defaultPreset();
      state.strategyId = preset ? preset.id : null;
      state.weights = presetWeights(state.strategyId);
    }
    if (state.strategyId) select.value = state.strategyId;
    select.disabled = isHuman || store.strategies.presets.length === 0;

    const refresh = () => {
      const preset = presetById(state.strategyId) || defaultPreset();
      description.textContent = preset ? asText(preset.description) : "";
      const metaBits = [];
      if (preset) {
        if (preset.pipeline) metaBits.push(asText(preset.pipeline));
        if (Number.isFinite(Number(preset.candidateLimit))) metaBits.push(`${preset.candidateLimit} candidates`);
        if (Number.isFinite(Number(preset.searchDepth))) metaBits.push(`depth ${preset.searchDepth}`);
        if (Array.isArray(preset.dims) && preset.dims.length) {
          metaBits.push(preset.dims.map((dim) => dimensionLabel(dim)).join(", "));
        }
      }
      presetMeta.textContent = metaBits.join(" · ");

      weightsBox.replaceChildren();
      if (isHuman) {
        weightsBox.appendChild(
          createElement("p", "field-help", "You play this side, so no Jev weights apply."),
        );
        return;
      }
      const sliders = store.strategies.sliders;
      if (!sliders.length) {
        weightsBox.appendChild(
          createElement("p", "field-help", "The server reported no weight sliders; the preset is used as is."),
        );
        return;
      }
      for (const slider of sliders) {
        if (!slider || typeof slider.key !== "string") continue;
        const row = document.createElement("div");
        row.className = "weight-control";
        const inputId = `weight-${side}-${slider.key}`;
        const label = document.createElement("label");
        label.className = "weight-control-label";
        label.setAttribute("for", inputId);
        label.textContent = asText(slider.label, dimensionLabel(slider.key));
        if (slider.help) label.title = asText(slider.help);
        const input = document.createElement("input");
        input.type = "range";
        input.id = inputId;
        input.className = "input input-range";
        input.min = String(Number.isFinite(Number(slider.min)) ? Number(slider.min) : 0);
        input.max = String(Number.isFinite(Number(slider.max)) ? Number(slider.max) : 1);
        input.step = String(Number.isFinite(Number(slider.step)) ? Number(slider.step) : 0.05);
        const current = Number(state.weights[slider.key]);
        const fallback = Number(slider.default);
        input.value = String(Number.isFinite(current) ? current : Number.isFinite(fallback) ? fallback : 0);
        const output = document.createElement("output");
        output.className = "weight-control-value";
        output.setAttribute("for", inputId);
        output.textContent = Number(input.value).toFixed(2);
        input.addEventListener("input", () => {
          const next = clamp(Number(input.value), Number(input.min), Number(input.max));
          state.weights[slider.key] = next;
          output.textContent = next.toFixed(2);
        });
        row.append(label, input, output);
        weightsBox.appendChild(row);
      }
    };

    select.addEventListener("change", () => {
      state.strategyId = select.value;
      state.weights = presetWeights(select.value);
      refresh();
    });
    refresh();
    dom.playersGrid.appendChild(fragment);
  }
}

function syncDialogForMode() {
  const mode = selectedMode();
  dom.colorField.hidden = mode !== "human-vs-jev";
  buildPlayerCards();
}

function syncCustomClock() {
  dom.customClock.hidden = dom.timeControl.value !== "custom";
}

function parseTimeControl() {
  const value = dom.timeControl.value;
  if (value === "none") return null;
  if (value === "custom") {
    const minutes = Number(dom.timeInitial.value);
    const increment = Number(dom.timeIncrement.value);
    const initialMs = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60000) : 300000;
    const incrementMs = Number.isFinite(increment) && increment >= 0 ? Math.round(increment * 1000) : 0;
    return { initialMs, incrementMs };
  }
  const match = /^(\d+)\+(\d+)$/.exec(value);
  if (!match) return null;
  return { initialMs: Number(match[1]) * 60000, incrementMs: Number(match[2]) * 1000 };
}

async function loadStrategies() {
  try {
    const payload = await api.strategies();
    store.strategies = {
      presets: Array.isArray(payload && payload.presets) ? payload.presets : [],
      sliders: Array.isArray(payload && payload.sliders) ? payload.sliders : [],
      pipelines: Array.isArray(payload && payload.pipelines) ? payload.pipelines : [],
    };
    dom.strategiesStatus.textContent = store.strategies.presets.length
      ? "Pick a preset per player; the sliders override its weights."
      : "The server reported no strategy presets; its default will be used.";
    return true;
  } catch (error) {
    store.strategies = { presets: [], sliders: [], pipelines: [] };
    dom.strategiesStatus.textContent = "Could not load strategies; the server default will be used.";
    reportError(error);
    return false;
  }
}

function showDialogError(message) {
  if (!message) {
    dom.dialogError.hidden = true;
    dom.dialogError.textContent = "";
    return;
  }
  dom.dialogError.hidden = false;
  dom.dialogError.textContent = message;
}

async function openNewGameDialog(options = {}) {
  showDialogError("");
  if (options.fen) dom.fenInput.value = options.fen;
  if (store.strategies.presets.length === 0) await loadStrategies();
  syncDialogForMode();
  if (dom.dialog && typeof dom.dialog.showModal === "function") {
    if (!dom.dialog.open) dom.dialog.showModal();
  } else if (dom.dialog) {
    dom.dialog.setAttribute("open", "");
  }
}

function closeNewGameDialog() {
  if (dom.dialog && typeof dom.dialog.close === "function" && dom.dialog.open) dom.dialog.close();
  else if (dom.dialog) dom.dialog.removeAttribute("open");
}

async function submitNewGame(event) {
  if (event && typeof event.preventDefault === "function") event.preventDefault();
  showDialogError("");
  const mode = selectedMode();
  const humanColor = selectedHumanColor();
  const fen = dom.fenInput.value.trim();
  const timeControl = parseTimeControl();

  if (fen && turnFromFen(fen) === null) {
    showDialogError("That FEN does not look right — its second field must be 'w' or 'b'.");
    return;
  }

  const players = {};
  for (const side of ["w", "b"]) {
    const isHuman = mode === "human-vs-jev" && side === humanColor;
    // A PlayerConfig is { strategyId, weights }. The human side needs no config:
    // the server reads `humanColor` to decide who is human.
    const state = playerConfigState[side];
    const config = {};
    if (!isHuman) {
      if (state.strategyId) config.strategyId = state.strategyId;
      if (state.weights && Object.keys(state.weights).length) config.weights = { ...state.weights };
    }
    players[side] = config;
  }

  const request = { mode, players, timeControl };
  if (mode === "human-vs-jev") request.humanColor = humanColor;
  if (fen) request.fen = fen;

  dom.dialogStart.disabled = true;
  try {
    const payload = await api.createGame(request);
    if (payload && payload.game) {
      stopStream();
      store.game = null;
      store.mode = "live";
      store.preview = null;
      store.previewPly = null;
      store.previewCandidate = null;
      store.selectedJevPly = null;
      store.userPickedJev = false;
      store.thinking = { ...IDLE_THINKING };
      store.flipped = payload.game.humanColor === "b";
      if (board) {
        board.setOrientation(store.flipped ? "b" : "w");
        board.clearPreview();
      }
      applySnapshot(payload.game);
      startStream(payload.game.id);
      closeNewGameDialog();
      toast(
        "info",
        mode === "jev-vs-jev"
          ? "New game: Jev vs Jev."
          : `New game: you play ${humanColor === "w" ? "White" : "Black"}.`,
      );
    }
  } catch (error) {
    showDialogError(error instanceof ApiError ? error.message : "Could not start the game.");
    reportError(error);
  } finally {
    dom.dialogStart.disabled = false;
  }
}

/* ---------------------------------------------------------- keyboard */

function onKeyDown(event) {
  const target = event.target;
  const typing =
    !!target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable === true);
  if (typing) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (dom.dialog && dom.dialog.open) return;

  const key = String(event.key).toLowerCase();
  if (key === "u") {
    event.preventDefault();
    undo();
  } else if (key === "f") {
    event.preventDefault();
    flip();
  } else if (key === "n") {
    event.preventDefault();
    openNewGameDialog();
  } else if (event.key === "Escape" && store.mode === "preview") {
    event.preventDefault();
    returnToLive();
  }
}

function flip() {
  store.flipped = !store.flipped;
  if (board) board.setOrientation(store.flipped ? "b" : "w");
  render();
}

/* ------------------------------------------------------------ wiring */

function wire() {
  board = new Board(dom.boardHost, {
    onMove: (move) => sendMove(move),
    onSelect: () => {},
    onDragStateChange: () => {},
  });
  board.setOrientation(store.flipped ? "b" : "w");
  jevPanel.setPreviewHandler((move) => previewCandidateMove(move));
  moveList.setPreviewHandler((ply) => previewPly(ply));

  dom.btnNew.addEventListener("click", () => openNewGameDialog());
  dom.btnUndo.addEventListener("click", () => undo());
  dom.btnFlip.addEventListener("click", () => flip());
  dom.btnResign.addEventListener("click", () => resign());
  dom.btnDraw.addEventListener("click", () => draw("offer"));
  dom.btnDrawAccept.addEventListener("click", () => draw("accept"));
  dom.btnDrawDecline.addEventListener("click", () => draw("decline"));
  dom.btnPause.addEventListener("click", () => toggleAutoplay());
  dom.btnStep.addEventListener("click", () => step());
  dom.btnArrows.addEventListener("click", () => {
    store.threatOn = !store.threatOn;
    render();
  });
  dom.btnCopyFen.addEventListener("click", () => copyText(store.game ? asText(store.game.fen) : "", "FEN"));
  dom.btnLoadFen.addEventListener("click", () => {
    openNewGameDialog({ fen: store.game ? asText(store.game.fen) : "" });
  });
  dom.btnCopyPgn.addEventListener("click", () => copyText(pgnText(), "PGN"));
  dom.btnDownloadPgn.addEventListener("click", () => {
    const game = store.game;
    downloadText(`jevchess-${slug(game && game.id)}.pgn`, pgnText());
  });

  dom.dialogForm.addEventListener("submit", (event) => submitNewGame(event));
  const closeButton = document.getElementById("dialog-close");
  const cancelButton = document.getElementById("dialog-cancel");
  if (closeButton) closeButton.addEventListener("click", () => closeNewGameDialog());
  if (cancelButton) cancelButton.addEventListener("click", () => closeNewGameDialog());
  dom.timeControl.addEventListener("change", () => syncCustomClock());
  for (const input of dom.dialogForm.querySelectorAll('input[name="mode"]')) {
    input.addEventListener("change", () => syncDialogForMode());
  }
  for (const input of dom.dialogForm.querySelectorAll('input[name="humanColor"]')) {
    input.addEventListener("change", () => syncDialogForMode());
  }

  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("beforeunload", () => stopStream());
}

/* ------------------------------------------------------------ start-up */

function startTicker() {
  window.setInterval(() => {
    const game = store.game;
    if (!game) return;
    const clocks = game.clocks && typeof game.clocks === "object" ? game.clocks : null;
    const thinking = store.thinking.active || !!(game.ai && game.ai.thinking);
    if (!clocks && !thinking) return;
    const now = localNow();
    renderPlayers(now);
    statusLine.update(game, now);
  }, 200);
}

async function start() {
  wire();
  syncCustomClock();

  try {
    const health = await api.health();
    store.health = health && typeof health === "object" ? health : null;
    if (store.health && Number.isFinite(Number(store.health.serverTime))) {
      noteServerTime(Number(store.health.serverTime));
    }
  } catch {
    toast("warn", "Could not reach /api/health — is the server running?");
  }

  try {
    await createDefaultGame();
  } catch (error) {
    reportError(error);
    toast("warn", "No game yet — use “New game” to start one.");
  }

  render();
  startTicker();
}

start().catch((error) => {
  reportError(error);
  try {
    render();
  } catch {
    /* without a usable DOM there is nothing left to do */
  }
});

export { store, render, api, previewPly, returnToLive };
