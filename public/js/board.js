/**
 * board.js — 8x8 SVG chess board: rendering, piece animation, drag & drop,
 * highlights, threat arrows and the promotion picker.
 *
 * Design notes
 *   - The board (squares, coordinates) is built exactly once. Piece nodes are
 *     diffed by square, so an update only changes `transform` on the nodes that
 *     moved: pieces slide, captured pieces fade out, promotions swap glyph, and
 *     the board itself never re-renders and never animates.
 *   - A piece is a single `<g class="piece">` holding one solid Unicode glyph
 *     drawn as `<text>`. The white-with-dark-outline / near-black-with-light-
 *     outline look comes from CSS (`fill` + `stroke` + `paint-order`), so no
 *     outline glyphs (♔♕♖♗♘♙) are ever needed.
 *   - `GameState.board` is ranked 8-first; this module owns the index <-> square
 *     mapping.
 *   - Read-only: the board never mutates `game`, it asks the app to send moves.
 */

import {
  attackedSquares,
  squareToXY,
  xyToSquare,
  boardIndex,
  legalTargetsFrom,
  needsPromotion,
  promotionChoices,
  pieceGlyph,
  pieceName,
  isSquare,
} from "./logic.js";

const NS = "http://www.w3.org/2000/svg";
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const PROMOTION_ORDER = ["q", "r", "b", "n"];
const CELL = 100;
const DRAG_THRESHOLD_PX = 4;

function svg(name, attrs = {}) {
  const element = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    element.setAttribute(key, String(value));
  }
  return element;
}

/** True when the board should currently accept pointer input. */
export function canInteract(state) {
  if (!state || !state.game) return false;
  const game = state.game;
  if (state.mode !== "live") return false;
  if (game.mode !== "human-vs-jev") return false;
  if (game.humanColor !== "w" && game.humanColor !== "b") return false;
  if (game.turn !== game.humanColor) return false;
  const status = game.status && typeof game.status === "object" ? game.status : {};
  if (status.over === true) return false;
  if (!Array.isArray(game.legalMoves) || game.legalMoves.length === 0) return false;
  return true;
}

export class Board {
  /**
   * @param {HTMLElement} host container element (the `.board-shell`)
   * @param {object} callbacks
   *   - onMove({ from, to, promotion })
   *   - onSelect(square|null)
   *   - onDragStateChange(dragging: boolean)
   */
  constructor(host, callbacks = {}) {
    this.host = host;
    this.callbacks = callbacks || {};
    this.state = null;
    this.orientation = "w";
    this.pieceNodes = new Array(64).fill(null);
    this.hasRenderedOnce = false;
    this.selected = null;
    this.dragActive = false;
    this.hoverSquare = null;
    this.pointerDrag = null;
    this.previewMove = null;
    this.pendingInput = false;
    this.squareNodes = new Map();

    this.build();
  }

  /* ------------------------------------------------------------- structure */

  build() {
    this.host.classList.add("board-shell");
    this.host.replaceChildren();

    this.svg = svg("svg", {
      class: "board",
      viewBox: "0 0 800 800",
      role: "grid",
      "aria-label": "Chess board. Drag a piece or click origin then destination.",
      preserveAspectRatio: "xMidYMid meet",
    });
    this.svg.setAttribute("tabindex", "0");

    this.defs = svg("defs");
    this.svg.appendChild(this.defs);

    this.squareLayer = svg("g", { class: "layer layer-squares" });
    this.highlightLayer = svg("g", { class: "layer layer-highlights" });
    this.markerLayer = svg("g", { class: "layer layer-markers" });
    this.pieceLayer = svg("g", { class: "layer layer-pieces" });
    this.arrowLayer = svg("g", { class: "layer layer-arrows" });
    this.previewLayer = svg("g", { class: "layer layer-preview" });
    this.coordLayer = svg("g", { class: "layer layer-coords" });
    this.svg.append(
      this.squareLayer,
      this.highlightLayer,
      this.markerLayer,
      this.pieceLayer,
      this.arrowLayer,
      this.previewLayer,
      this.coordLayer,
    );

    this.buildSquares();
    this.buildCoordinates();
    this.ensureArrowMarker();
    this.host.appendChild(this.svg);

    this.ghost = document.createElement("div");
    this.ghost.className = "drag-ghost";
    this.ghost.setAttribute("aria-hidden", "true");
    this.ghost.hidden = true;
    this.host.appendChild(this.ghost);

    this.promotion = document.createElement("div");
    this.promotion.className = "promotion-picker";
    this.promotion.setAttribute("role", "dialog");
    this.promotion.setAttribute("aria-label", "Choose a promotion piece");
    this.promotion.hidden = true;
    this.host.appendChild(this.promotion);

    this.setOrientation("w");
    this.bindPointer();
  }

  buildSquares() {
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const square = xyToSquare(x, y);
        const dark = (x + y) % 2 === 0; // a1 is a dark square
        const node = svg("rect", {
          class: `square ${dark ? "square-dark" : "square-light"}`,
          x: this.px(x),
          y: this.py(y),
          width: CELL,
          height: CELL,
          "data-square": square,
        });
        this.squareLayer.appendChild(node);
        this.squareNodes.set(square, node);
      }
    }
  }

  buildCoordinates() {
    for (let i = 0; i < 8; i += 1) {
      const fileText = svg("text", {
        class: "coord coord-file",
        x: this.px(i) + CELL / 2,
        y: this.py(0) + CELL - 9,
        "text-anchor": "middle",
      });
      fileText.textContent = FILES[i];
      this.coordLayer.appendChild(fileText);

      const rankText = svg("text", {
        class: "coord coord-rank",
        x: this.px(0) + 11,
        y: this.py(i) + 22,
      });
      rankText.textContent = String(i + 1);
      this.coordLayer.appendChild(rankText);
    }
  }

  /* ------------------------------------------------------------- geometry */

  /** SVG x for file `x` (a..h = 0..7), in board coordinates. */
  px(x) {
    return x * CELL;
  }

  /** SVG y for rank `y` (1..8 = 0..7), in board coordinates. */
  py(y) {
    return (7 - y) * CELL;
  }

  /** Board index for a square name, or -1. */
  indexOf(square) {
    const xy = squareToXY(square);
    return xy ? boardIndex(xy.x, xy.y) : -1;
  }

  /** Square name for a board index. */
  squareOf(index) {
    return xyToSquare(index % 8, 7 - Math.floor(index / 8));
  }

  setOrientation(color) {
    this.orientation = color === "b" ? "b" : "w";
    this.svg.dataset.orientation = this.orientation;
    this.applyOrientation();
  }

  applyOrientation() {
    const flipped = this.orientation === "b";
    const rotate = flipped ? "rotate(180 400 400)" : "";
    this.svg.classList.toggle("flipped", flipped);
    this.coordLayer.classList.toggle("coords-flipped", flipped);
    // Rotate the positioned layers wholesale; glyphs counter-rotate to stay upright.
    this.pieceLayer.setAttribute("transform", rotate);
    this.markerLayer.setAttribute("transform", rotate);
    for (const node of this.pieceNodes) {
      if (node) {
        const glyph = node.querySelector("text.piece-glyph");
        if (glyph) glyph.setAttribute("transform", flipped ? "rotate(180 50 50)" : "");
      }
    }
  }

  /* --------------------------------------------------------------- render */

  /**
   * Apply a new store snapshot.
   * @param {object} state
   *   { game, mode:"live"|"preview", board, lastMove, check, legalMoves, threatOn }
   * @returns {Array} the piece moves that were animated
   */
  render(state) {
    const previous = this.state;
    this.state = state || null;
    if (!state || !state.game) {
      this.clearAll();
      return [];
    }
    const animate = this.hasRenderedOnce;
    const board = Array.isArray(state.board) ? state.board : state.game.board;
    let moves = [];

    if (Array.isArray(board) && board.length === 64) {
      moves = this.syncPieces(board, animate);
    } else {
      this.clearPieces();
    }

    this.renderHighlights();
    this.renderMarkers();
    this.renderArrows();

    const status = state.game.status && typeof state.game.status === "object" ? state.game.status : {};
    this.svg.dataset.boardState =
      status.over === true ? "over" : state.mode === "preview" ? "preview" : "live";
    this.hasRenderedOnce = true;

    if (previous && previous.mode === "preview" && state.mode === "live") this.clearPreview();
    return moves;
  }

  clearAll() {
    this.clearPieces();
    this.highlightLayer.replaceChildren();
    this.markerLayer.replaceChildren();
    this.arrowLayer.replaceChildren();
    this.clearPreview();
    this.svg.dataset.boardState = "empty";
  }

  clearPieces() {
    for (const node of this.pieceNodes) if (node) node.remove();
    this.pieceNodes = new Array(64).fill(null);
  }

  /**
   * Diff the previous piece layout against `board`, touching as little DOM as
   * possible. Returns the list of animated moves.
   */
  syncPieces(board, animate) {
    const previous = this.pieceNodes.slice();
    const claimed = new Set();
    const next = new Array(64).fill(null);
    const moves = [];

    for (let index = 0; index < 64; index += 1) {
      const raw = board[index];
      const piece = raw && typeof raw === "object" ? raw : null;
      if (!piece || !pieceGlyph(piece.type)) continue;
      if (piece.color !== "w" && piece.color !== "b") continue;

      const square = this.squareOf(index);
      const type = String(piece.type).toLowerCase();
      const color = piece.color;
      let node = null;

      // 1. The node already sitting on this square keeps it.
      if (previous[index] && !claimed.has(index)) {
        node = previous[index];
        claimed.add(index);
      }

      // 2. Otherwise reuse a free node so the piece slides instead of popping.
      //    Preference: same piece (a plain move / a hop), then same colour (a
      //    promotion stepping out), then anything still unclaimed.
      if (!node) {
        const found =
          this.findFreeNode(previous, board, claimed, (n) => n.dataset.type === type && n.dataset.color === color, index) ||
          this.findFreeNode(previous, board, claimed, (n) => n.dataset.color === color, index) ||
          this.findFreeNode(previous, board, claimed, () => true, index);
        if (found) {
          node = found.node;
          claimed.add(found.old);
        }
      }

      if (!node) {
        node = this.createPieceNode(type, color);
        this.pieceLayer.appendChild(node);
        node.classList.add("piece-enter");
        if (animate) requestAnimationFrame(() => node.classList.remove("piece-enter"));
        else node.classList.remove("piece-enter");
      } else {
        this.paintPiece(node, type, color);
      }

      const xy = squareToXY(square);
      const oldSquare = node.__square;
      const oldXY = oldSquare ? squareToXY(oldSquare) : null;
      const sameCell = !!oldXY && oldXY.x === xy.x && oldXY.y === xy.y;

      node.dataset.square = square;
      node.dataset.color = color;
      node.dataset.type = type;
      node.__square = square;
      node.setAttribute(
        "aria-label",
        `${color === "w" ? "White" : "Black"} ${pieceName(type)} on ${square}`,
      );

      const target = `translate(${this.px(xy.x)},${this.py(xy.y)})`;
      if (animate && oldXY && !sameCell) {
        // Bake the previous position in with transitions off, then transition out.
        node.style.transition = "none";
        node.setAttribute("transform", `translate(${this.px(oldXY.x)},${this.py(oldXY.y)})`);
        void node.getBoundingClientRect();
        node.style.transition = "";
        node.setAttribute("transform", target);
        moves.push({ node, from: oldSquare, to: square, type });
      } else {
        node.setAttribute("transform", target);
      }
      next[index] = node;
    }

    for (let index = 0; index < 64; index += 1) {
      const node = previous[index];
      if (!node || claimed.has(index)) continue;
      if (next.indexOf(node) !== -1) continue;
      this.fadeOutPiece(node);
    }

    this.pieceNodes = next;
    if (this.dragActive) this.markDraggedPiece();
    return moves;
  }

  /**
   * Pick an existing node that should slide to `index`. A node is only reusable
   * when the new layout does not keep the same piece on its old square — that is
   * what stops a promotion from stealing the node of a piece that never moved.
   *
   * @param {(node:Element)=>boolean} predicate which node kinds are acceptable
   */
  findFreeNode(previous, board, claimed, predicate, index) {
    const candidates = [];
    for (let old = 0; old < 64; old += 1) {
      const node = previous[old];
      if (!node || claimed.has(old)) continue;
      if (!predicate(node)) continue;
      const occupant = board[old];
      const occupantMatches =
        !!occupant &&
        typeof occupant === "object" &&
        String(occupant.type).toLowerCase() === node.dataset.type &&
        occupant.color === node.dataset.color;
      if (occupantMatches) continue; // that node still has a job where it is
      candidates.push({ node, old });
    }
    if (candidates.length === 0) return null;
    // Prefer the nearest node so castling / short moves hop the fewest squares.
    const target = squareToXY(this.squareOf(index));
    candidates.sort((a, b) => distance(a.old, target) - distance(b.old, target));
    return candidates[0];
  }

  fadeOutPiece(node) {
    node.classList.add("piece-captured");
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      node.remove();
    };
    node.addEventListener("transitionend", remove, { once: true });
    window.setTimeout(remove, 340);
  }

  createPieceNode(type, color) {
    const node = svg("g", { class: "piece" });
    const glyph = svg("text", {
      class: `piece-glyph piece-${color}`,
      x: 50,
      y: 50,
      "text-anchor": "middle",
      "dominant-baseline": "central",
    });
    glyph.textContent = pieceGlyph(type);
    if (this.orientation === "b") glyph.setAttribute("transform", "rotate(180 50 50)");
    node.appendChild(glyph);
    return node;
  }

  paintPiece(node, type, color) {
    const glyph = node.querySelector("text.piece-glyph");
    if (!glyph) return;
    const text = pieceGlyph(type);
    if (glyph.textContent !== text) glyph.textContent = text;
    glyph.setAttribute("class", `piece-glyph piece-${color}`);
  }

  /* ----------------------------------------------------------- highlights */

  highlightRects() {
    const out = [];
    const state = this.state;
    if (!state || !state.game) return out;
    const game = state.game;
    const lastMove = state.lastMove || game.lastMove || null;
    if (lastMove && isSquare(lastMove.from)) out.push({ square: lastMove.from, kind: "last-from" });
    if (lastMove && isSquare(lastMove.to)) out.push({ square: lastMove.to, kind: "last-to" });
    const check = state.check || game.check || null;
    if (check && check.inCheck === true && isSquare(check.square)) {
      out.push({ square: check.square, kind: "check" });
    }
    if (this.selected && isSquare(this.selected)) out.push({ square: this.selected, kind: "selected" });
    if (this.hoverSquare && isSquare(this.hoverSquare) && this.hoverSquare !== this.selected) {
      out.push({ square: this.hoverSquare, kind: "hover" });
    }
    return out;
  }

  renderHighlights() {
    this.highlightLayer.replaceChildren();
    for (const { square, kind } of this.highlightRects()) {
      const xy = squareToXY(square);
      if (!xy) continue;
      this.highlightLayer.appendChild(
        svg("rect", {
          class: `highlight highlight-${kind}`,
          x: this.px(xy.x),
          y: this.py(xy.y),
          width: CELL,
          height: CELL,
          "data-square": square,
          "data-kind": kind,
        }),
      );
    }
  }

  /* -------------------------------------------------------------- markers */

  /** Legal destinations for the currently picked-up / selected piece. */
  selectableSquares() {
    const state = this.state;
    if (!state || !state.game) return [];
    if (state.mode !== "live") return [];
    const legalMoves = Array.isArray(state.legalMoves) ? state.legalMoves : [];
    const from = this.selected || (this.pointerDrag ? this.pointerDrag.from : null);
    if (!from) return [];
    const board = Array.isArray(state.board) ? state.board : state.game.board;
    return legalTargetsFrom(from, legalMoves).map((move) => {
      const index = this.indexOf(move.to);
      const occupied = index >= 0 && Array.isArray(board) ? !!board[index] : false;
      const isCapture = (typeof move.captured === "string" && move.captured !== "") || occupied;
      return {
        square: move.to,
        capture: isCapture,
        promotion: !!move.promotion,
        san: typeof move.san === "string" ? move.san : "",
      };
    });
  }

  renderMarkers() {
    this.markerLayer.replaceChildren();
    this.markerLayer.setAttribute("transform", this.orientation === "b" ? "rotate(180 400 400)" : "");
    for (const target of this.selectableSquares()) {
      const xy = squareToXY(target.square);
      if (!xy) continue;
      const cx = this.px(xy.x) + CELL / 2;
      const cy = this.py(xy.y) + CELL / 2;
      const node = target.capture
        ? svg("circle", { class: "marker marker-capture", cx, cy, r: 44, "data-square": target.square })
        : svg("circle", { class: "marker marker-dot", cx, cy, r: 15, "data-square": target.square });
      if (target.promotion) node.classList.add("marker-promotion");
      this.markerLayer.appendChild(node);
    }
  }

  /* --------------------------------------------------------------- arrows */

  /** Arrow-head marker definition (idempotent). */
  ensureArrowMarker() {
    if (this.defs.querySelector("#threat-head")) return;
    const marker = svg("marker", {
      id: "threat-head",
      viewBox: "0 0 10 10",
      refX: 8,
      refY: 5,
      markerWidth: 5,
      markerHeight: 5,
      orient: "auto-start-reverse",
    });
    marker.appendChild(svg("path", { class: "arrow-head", d: "M 0 0 L 10 5 L 0 10 z" }));
    this.defs.appendChild(marker);
  }

  /**
   * Client-side threat map: every enemy attack that lands on one of our pieces
   * becomes an arrow from the attacker to the victim.
   */
  threatArrows() {
    const state = this.state;
    if (!state || !state.game) return [];
    if (state.mode !== "live") return [];
    const game = state.game;
    const legalMoves = Array.isArray(game.legalMoves) ? game.legalMoves : [];
    if (legalMoves.length === 0) return [];
    const turn = game.turn === "b" ? "b" : "w";
    const board = Array.isArray(state.board) ? state.board : game.board;
    const arrows = [];
    for (const attack of attackedSquares(legalMoves, turn)) {
      const index = this.indexOf(attack.target);
      const victim = index >= 0 && Array.isArray(board) ? board[index] : null;
      if (!victim || typeof victim !== "object") continue;
      if (victim.color === turn) continue; // the arrow must land on the other side
      for (const attacker of attack.attackers) {
        arrows.push({ from: attacker.from, to: attack.target, san: attacker.san });
      }
    }
    return arrows;
  }

  renderArrows() {
    this.arrowLayer.replaceChildren();
    const state = this.state;
    const show = !!(state && state.threatOn === true);
    this.svg.classList.toggle("show-threats", show);
    if (!show) return;
    this.ensureArrowMarker();
    for (const arrow of this.threatArrows()) {
      const path = this.arrowPath(arrow.from, arrow.to);
      if (!path) continue;
      this.arrowLayer.appendChild(
        svg("path", {
          class: "threat-arrow",
          d: path,
          "marker-end": "url(#threat-head)",
          "data-from": arrow.from,
          "data-to": arrow.to,
          "data-san": arrow.san || "",
        }),
      );
    }
  }

  /** Straight arrow between two squares, trimmed so it does not cover the pieces. */
  arrowPath(from, to) {
    const a = squareToXY(from);
    const b = squareToXY(to);
    if (!a || !b) return null;
    const ax = this.px(a.x) + CELL / 2;
    const ay = this.py(a.y) + CELL / 2;
    const bx = this.px(b.x) + CELL / 2;
    const by = this.py(b.y) + CELL / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const trim = 38;
    const sx = ax + (dx / len) * trim;
    const sy = ay + (dy / len) * trim;
    const ex = bx - (dx / len) * trim;
    const ey = by - (dy / len) * trim;
    return `M ${sx.toFixed(1)} ${sy.toFixed(1)} L ${ex.toFixed(1)} ${ey.toFixed(1)}`;
  }

  /* -------------------------------------------------------------- preview */

  /** Read-only overlay for a candidate move (judgment-panel preview). */
  previewCandidate(move) {
    this.previewMove =
      move && isSquare(move.from) && isSquare(move.to)
        ? { from: move.from, to: move.to, san: typeof move.san === "string" ? move.san : "" }
        : null;
    this.renderPreview();
  }

  renderPreview() {
    this.previewLayer.replaceChildren();
    const move = this.previewMove;
    if (!move) return;
    const a = squareToXY(move.from);
    const b = squareToXY(move.to);
    if (!a || !b) return;
    for (const [xy, kind] of [
      [a, "preview-from"],
      [b, "preview-to"],
    ]) {
      this.previewLayer.appendChild(
        svg("rect", {
          class: `preview-rect ${kind}`,
          x: this.px(xy.x),
          y: this.py(xy.y),
          width: CELL,
          height: CELL,
        }),
      );
    }
    this.ensureArrowMarker();
    this.previewLayer.appendChild(
      svg("path", {
        class: "preview-arrow",
        d: this.arrowPath(move.from, move.to),
        "marker-end": "url(#threat-head)",
      }),
    );
  }

  clearPreview() {
    this.previewMove = null;
    this.previewLayer.replaceChildren();
  }

  /* ----------------------------------------------------------- interaction */

  bindPointer() {
    this.svg.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.svg.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.svg.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.svg.addEventListener("pointercancel", () => this.onPointerCancel());
    this.svg.addEventListener("contextmenu", (event) => event.preventDefault());
    this.svg.addEventListener("keydown", (event) => this.onKeyDown(event));
  }

  /** Hit-test the pointer. Uses the DOM when possible, geometry otherwise. */
  squareFromEvent(event) {
    const target = event.target;
    const node =
      target && typeof target.closest === "function" ? target.closest("[data-square]") : null;
    if (node) {
      const square = node.getAttribute("data-square");
      if (isSquare(square)) return square;
    }
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    let fx = (event.clientX - rect.left) / rect.width;
    let fy = (event.clientY - rect.top) / rect.height;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    if (this.orientation === "b") {
      fx = 1 - fx;
      fy = 1 - fy;
    }
    const file = Math.min(7, Math.max(0, Math.floor(fx * 8)));
    const rowFromTop = Math.min(7, Math.max(0, Math.floor(fy * 8)));
    return xyToSquare(file, 7 - rowFromTop);
  }

  pieceAt(square) {
    const state = this.state;
    if (!state || !state.game) return null;
    const index = this.indexOf(square);
    if (index < 0) return null;
    const board = Array.isArray(state.board) ? state.board : state.game.board;
    if (!Array.isArray(board)) return null;
    const piece = board[index];
    return piece && typeof piece === "object" && (piece.color === "w" || piece.color === "b")
      ? piece
      : null;
  }

  myColor() {
    const game = this.state && this.state.game;
    return game && (game.humanColor === "w" || game.humanColor === "b") ? game.humanColor : null;
  }

  isMyPiece(square) {
    const piece = this.pieceAt(square);
    return !!piece && piece.color === this.myColor();
  }

  onPointerDown(event) {
    if (typeof event.button === "number" && event.button !== 0) return;
    if (this.pendingInput) return;
    const square = this.squareFromEvent(event);
    if (!square) return;
    if (!canInteract(this.state)) return;

    const selected = this.selected;
    if (selected && selected !== square && this.tryPlay(selected, square)) {
      event.preventDefault();
      return;
    }
    if (!this.isMyPiece(square)) {
      this.setSelected(null);
      return;
    }

    event.preventDefault();
    this.setSelected(square);
    const xy = squareToXY(square);
    this.pointerDrag = {
      from: square,
      x: xy.x,
      y: xy.y,
      pointerId: event.pointerId,
      started: false,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
    try {
      this.svg.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture is a nicety, not a requirement */
    }
  }

  onPointerMove(event) {
    const drag = this.pointerDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.started && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;

    if (!drag.started) {
      drag.started = true;
      this.dragActive = true;
      this.markDraggedPiece();
      this.host.classList.add("is-dragging");
      this.showGhost(drag.from);
      this.moveGhost(event.clientX, event.clientY);
      if (typeof this.callbacks.onDragStateChange === "function") {
        this.callbacks.onDragStateChange(true);
      }
    }

    const square = this.squareFromEvent(event);
    if (square !== this.hoverSquare) {
      this.hoverSquare = square;
      this.renderHighlights();
    }
    this.moveGhost(event.clientX, event.clientY);
  }

  onPointerUp(event) {
    const drag = this.pointerDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.pointerDrag = null;
    try {
      this.svg.releasePointerCapture(event.pointerId);
    } catch {
      /* not captured */
    }

    if (!drag.started) {
      this.hoverSquare = null;
      this.renderHighlights();
      return;
    }

    this.endDrag();
    const square = this.squareFromEvent(event);
    if (!square || square === drag.from || !this.tryPlay(drag.from, square)) {
      this.snapBack(drag.from);
    }
  }

  onPointerCancel() {
    const drag = this.pointerDrag;
    if (!drag) return;
    this.pointerDrag = null;
    this.endDrag();
    this.snapBack(drag.from);
  }

  onKeyDown(event) {
    if (event.key === "Escape") {
      this.setSelected(null);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const from = this.selected;
      if (!from) return;
      const targets = this.selectableSquares();
      if (targets.length !== 1) return;
      event.preventDefault();
      this.tryPlay(from, targets[0].square);
    }
  }

  endDrag() {
    this.dragActive = false;
    this.hoverSquare = null;
    this.host.classList.remove("is-dragging");
    this.ghost.hidden = true;
    this.unmarkDraggedPiece();
    if (typeof this.callbacks.onDragStateChange === "function") {
      this.callbacks.onDragStateChange(false);
    }
  }

  markDraggedPiece() {
    const from = this.pointerDrag ? this.pointerDrag.from : null;
    for (const node of this.pieceNodes) {
      if (node) node.classList.toggle("piece-dragging", !!from && node.dataset.square === from);
    }
  }

  unmarkDraggedPiece() {
    for (const node of this.pieceNodes) if (node) node.classList.remove("piece-dragging");
  }

  showGhost(square) {
    const piece = this.pieceAt(square);
    if (!piece) return;
    this.ghost.hidden = false;
    this.ghost.textContent = pieceGlyph(piece.type);
    this.ghost.className = `drag-ghost drag-ghost-${piece.color}`;
  }

  moveGhost(clientX, clientY) {
    const rect = this.host.getBoundingClientRect();
    this.ghost.style.transform =
      `translate(${clientX - rect.left}px, ${clientY - rect.top}px) translate(-50%, -50%)`;
  }

  /** Visual nudge after an illegal drop. */
  snapBack(square) {
    const index = square ? this.indexOf(square) : -1;
    const node = index >= 0 ? this.pieceNodes[index] : null;
    if (!node) return;
    node.classList.add("piece-snapback");
    window.setTimeout(() => node.classList.remove("piece-snapback"), 260);
  }

  /**
   * Attempt `from` -> `to`. Returns true when the move was accepted: either a
   * move request is on its way, or the promotion picker took over.
   */
  tryPlay(from, to) {
    const state = this.state;
    if (!canInteract(state)) return false;
    const legalMoves = Array.isArray(state.legalMoves) ? state.legalMoves : [];
    const targets = legalTargetsFrom(from, legalMoves).filter((move) => move.to === to);
    if (targets.length === 0) return false;

    this.setSelected(null);
    if (needsPromotion(from, to, legalMoves)) {
      this.openPromotionPicker(from, to, promotionChoices(from, to, legalMoves));
      return true;
    }
    if (typeof this.callbacks.onMove === "function") {
      this.callbacks.onMove({ from, to, promotion: null });
    }
    return true;
  }

  setSelected(square) {
    const next = isSquare(square) ? square : null;
    if (next === this.selected) return;
    this.selected = next;
    this.renderHighlights();
    this.renderMarkers();
    if (typeof this.callbacks.onSelect === "function") this.callbacks.onSelect(next);
  }

  /* ------------------------------------------------------ promotion picker */

  openPromotionPicker(from, to, choices = PROMOTION_ORDER) {
    const list = Array.isArray(choices) && choices.length ? choices : PROMOTION_ORDER;
    this.pendingInput = true;
    this.promotion.replaceChildren();
    const color = this.myColor() === "b" ? "b" : "w";

    const title = document.createElement("p");
    title.className = "promotion-title";
    title.textContent = "Promote to";
    this.promotion.appendChild(title);

    const row = document.createElement("div");
    row.className = "promotion-row";
    for (const piece of list) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `promotion-choice promotion-${piece} piece-${color}`;
      button.dataset.piece = piece;
      button.setAttribute("aria-label", `Promote to ${pieceName(piece)}`);
      button.textContent = pieceGlyph(piece);
      button.addEventListener("click", () => {
        this.closePromotionPicker();
        if (typeof this.callbacks.onMove === "function") {
          this.callbacks.onMove({ from, to, promotion: piece });
        }
      });
      row.appendChild(button);
    }
    this.promotion.appendChild(row);

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "promotion-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.closePromotionPicker());
    this.promotion.appendChild(cancel);

    this.promotion.hidden = false;
    const first = this.promotion.querySelector("button");
    if (first && typeof first.focus === "function") first.focus();
  }

  closePromotionPicker() {
    this.promotion.hidden = true;
    this.promotion.replaceChildren();
    this.pendingInput = false;
  }

  /** Cancel a stale picker when a new snapshot arrives. */
  cancelPendingInput() {
    if (this.promotion.hidden === false) this.closePromotionPicker();
    this.pendingInput = false;
  }

  isPromotionOpen() {
    return this.promotion.hidden === false;
  }
}

/** Euclidean distance between a board index and a file/rank target. */
function distance(index, target) {
  const x = index % 8;
  const y = 7 - Math.floor(index / 8);
  if (!target) return 0;
  return Math.hypot(target.x - x, target.y - y);
}

export default Board;
