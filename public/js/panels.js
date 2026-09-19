/**
 * panels.js — every non-board surface of the UI: Jev judgment panel, move list,
 * clocks, status line, eval bar, banners and toasts.
 *
 * Each factory takes the element it owns and returns `{ el, update(...) }`.
 * Nothing here reads global state: the app hands each panel a plain snapshot.
 */

import {
  candidateRows,
  weightEntries,
  auditRows,
  dimensionKeys,
  dimensionLabel,
  formatClock,
  formatMoveLabel,
  formatPercent,
  formatSeconds,
  formatTokens,
  formatMaterialDiff,
  isLowClock,
  clockRemaining,
  evalBarFraction,
  pairMoves,
  colorName,
  statusText,
  asText,
  strategyTally,
} from "./logic.js";

/* ------------------------------------------------------------------ helpers */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  if (node) node.replaceChildren();
}

/** A 0..1 bar with a label, used for choice probabilities and dimensions. */
function bar(fraction, variant, caption) {
  const wrap = el("span", `bar bar-${variant}`);
  const track = el("span", "bar-track");
  const fill = el("span", "bar-fill");
  const value = typeof fraction === "number" && Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : null;
  fill.style.width = value === null ? "0%" : `${(value * 100).toFixed(1)}%`;
  track.appendChild(fill);
  wrap.appendChild(track);
  if (caption !== undefined) wrap.appendChild(el("span", "bar-value", caption));
  wrap.title = caption ? String(caption) : "";
  return wrap;
}

/* ---------------------------------------------------------------- top bar */

/** Player card: name, kind badge and the strategy/pipeline in force. */
export function createPlayerCard(root) {
  const name = el("span", "player-name", "—");
  const meta = el("span", "player-meta", "");
  const badge = el("span", "player-badge", "");
  const clock = el("span", "player-clock", "");
  const turn = el("span", "player-turn", "");
  turn.hidden = true;
  root.append(name, meta, badge, turn, clock);
  root.classList.add("player-card");

  return {
    el: root,
    /** @param {{name,kind,strategyName,pipeline}|null} player */
    update(player, color, extra = {}) {
      const p = player && typeof player === "object" ? player : {};
      name.textContent = asText(p.name) || (p.kind === "jev" ? "Jev" : "Human");
      const bits = [];
      if (p.kind === "jev") {
        if (p.strategyId || p.name) bits.push(asText(p.strategyId) || asText(p.name));
        if (p.pipeline) bits.push(asText(p.pipeline));
      } else if (p.kind === "human") {
        bits.push("human");
      }
      meta.textContent = bits.filter(Boolean).join(" · ");
      badge.textContent = p.kind === "jev" ? "Jev" : p.kind === "human" ? "You" : "—";
      badge.className = `player-badge player-badge-${p.kind === "jev" ? "jev" : p.kind === "human" ? "human" : "none"}`;
      root.dataset.color = color === "b" ? "b" : "w";
      root.classList.toggle("is-active", extra.active === true);

      const remaining = extra.remainingMs;
      if (remaining === null || remaining === undefined) {
        clock.textContent = "";
        clock.hidden = true;
      } else {
        clock.hidden = false;
        clock.textContent = formatClock(remaining);
        clock.classList.toggle("clock-low", isLowClock(remaining));
        clock.classList.toggle("clock-running", extra.running === true);
      }
      const thinking = extra.thinking === true;
      root.classList.toggle("is-thinking", thinking);
      root.dataset.thinking = thinking ? "true" : "false";
      // The seat on the move says so, with its name and a live clock while it thinks: a watcher
      // should never have to guess whose turn it is before the piece moves.
      const onMove = extra.active === true || thinking;
      turn.hidden = !onMove;
      if (onMove) {
        const seat = asText(p.name) || (p.kind === "jev" ? "Jev" : "you");
        turn.textContent = thinking ? `${seat} thinking… ${formatSeconds(Number(extra.elapsedMs ?? 0))}s` : "to move";
        turn.classList.toggle("is-thinking", thinking);
      } else {
        turn.textContent = "";
      }
      if (extra.material !== undefined) {
        root.dataset.material = String(extra.material);
      }
    },
  };
}

/** Status line + "AI thinking…" indicator. */
export function createStatusLine(root) {
  const text = el("span", "status-text", "Loading…");
  const thinking = el("span", "status-thinking", "");
  thinking.hidden = true;
  const material = el("span", "status-material", "");
  root.append(text, thinking, material);
  root.classList.add("status-line");

  return {
    el: root,
    /** @param {object|null} game @param {number} now */
    update(game, now = Date.now()) {
      const { text: label, tone } = statusText(game);
      text.textContent = label;
      root.dataset.tone = tone;

      const ai = game && game.ai && typeof game.ai === "object" ? game.ai : null;
      if (ai && ai.thinking === true) {
        const started = Number(ai.startedAt);
        const elapsed = Number.isFinite(started) ? Math.max(0, now - started) : 0;
        const who = ai.side ? colorName(ai.side) : "Jev";
        const strategy = ai.strategyName ? ` (${ai.strategyName})` : "";
        thinking.hidden = false;
        thinking.textContent = `${who}${strategy} is thinking… ${formatSeconds(elapsed)}s`;
      } else {
        thinking.hidden = true;
        thinking.textContent = "";
      }

      const board = game && Array.isArray(game.board) ? game.board : null;
      if (board) {
        const diff = formatMaterialDiff(board);
        material.textContent = diff === "=" ? "" : `material ${diff}`;
        material.hidden = diff === "=";
      } else {
        material.textContent = "";
        material.hidden = true;
      }
    },
  };
}

/** Vertical eval bar. */
export function createEvalBar(root) {
  const white = el("div", "eval-white");
  const marker = el("div", "eval-marker");
  const label = el("div", "eval-label", "—");
  const source = el("div", "eval-source", "");
  root.append(white, marker, label, source);
  root.classList.add("eval-bar");
  root.setAttribute("role", "img");

  return {
    el: root,
    /** @param {{cp,whiteWinProb,source,label}|null} evalBar */
    update(evalBar) {
      const data = evalBar && typeof evalBar === "object" ? evalBar : null;
      if (!data) {
        white.style.height = "50%";
        root.dataset.available = "false";
        label.textContent = "—";
        source.textContent = "";
        root.setAttribute("aria-label", "Evaluation unavailable");
        return;
      }
      root.dataset.available = "true";
      const fraction = evalBarFraction(data.whiteWinProb);
      white.style.height = `${(fraction * 100).toFixed(1)}%`;
      const shown = Number.isFinite(Number(data.whiteWinProb))
        ? formatPercent(fraction, 0)
        : asText(data.label, "—");
      label.textContent = asText(data.label) || shown;
      source.textContent = data.source === "jev" ? "Jev" : data.source === "search" ? "search" : asText(data.source, "");
      root.setAttribute("aria-label", `Evaluation ${label.textContent} (${source.textContent || "unknown"})`);
    },
  };
}

/* ------------------------------------------------------- Jev judgment panel */

/** Renders `MoveRecord.jev` (a `JevMove`), the weights in force and the audit. */
export function createJevPanel(root) {
  root.classList.add("jev-panel");
  const header = el("header", "jev-header");
  const headline = el("div", "jev-headline");
  const headlineSan = el("span", "jev-chosen", "—");
  const headlineMeta = el("span", "jev-chosen-meta", "");
  headline.append(headlineSan, headlineMeta);
  const badges = el("div", "jev-badges");
  const mockBadge = el("span", "badge badge-mock", "Mock Jev (no API key)");
  mockBadge.hidden = true;
  badges.appendChild(mockBadge);
  header.append(headline, badges);

  const impact = el("p", "jev-impact", "");
  impact.hidden = true;

  // The strategy layer, above the judgement: a watcher should be able to read what this seat is
  // trying to do before reading how it scored one move.
  const planBox = el("section", "jev-plan");
  const planBody = el("div", "jev-plan-body");
  planBox.append(planBody);

  const weightsBox = el("details", "jev-weights");
  const weightsSummary = el("summary", "jev-weights-summary", "Weights in force");
  const weightsBody = el("div", "jev-weights-body");
  weightsBox.append(weightsSummary, weightsBody);

  const table = el("div", "jev-candidates");
  const notesBox = el("div", "jev-notes");
  const auditBox = el("details", "jev-audit");
  const auditSummary = el("summary", "jev-audit-summary", "Audit");
  const auditBody = el("div", "jev-audit-body");
  auditBox.append(auditSummary, auditBody);
  auditBox.hidden = true;

  const footer = el("div", "jev-footer");
  const errors = el("div", "jev-errors");
  errors.hidden = true;

  root.append(header, planBox, impact, weightsBox, table, notesBox, footer, auditBox, errors);

  let onPreview = null;

  return {
    el: root,
    /** @param {(candidate:object|null)=>void} fn */
    setPreviewHandler(fn) {
      onPreview = typeof fn === "function" ? fn : null;
    },
    /**
     * @param {object|null} record MoveRecord (its `.jev` is rendered)
     * @param {object|null} game for the `jev.hasApiKey` / `jev.mock` fallback
     */
    update(record, game) {
      const jev = record && record.jev && typeof record.jev === "object" ? record.jev : null;
      const gameJev = game && game.jev && typeof game.jev === "object" ? game.jev : null;
      const isMock = jev ? jev.mock === true : !!(gameJev && gameJev.mock === true);
      mockBadge.hidden = !isMock;

      root.dataset.empty = jev ? "false" : "true";
      if (!jev) {
        headlineSan.textContent = "—";
        headlineMeta.textContent = "";
        impact.hidden = true;
        clear(weightsBody);
        weightsBox.open = false;
        clear(table);
        table.appendChild(
          el(
            "p",
            "jev-empty",
            game && game.jev && game.jev.hasApiKey === false
              ? "No Jev move yet. Add TYPESAFE_API_KEY to .env to let Jev judge moves."
              : "No Jev move to inspect yet.",
          ),
        );
        clear(notesBox);
        auditBox.hidden = true;
        clear(auditBody);
        clear(footer);
        errors.hidden = true;
        clear(errors);
        renderPlan(planBody, {
          planned: planInForce(game),
          meta: null,
          gameLlm: game ? game.llm : null,
          game,
          color: game ? game.turn : null,
          seatPlans: seatUsesStrategist(game, game ? game.turn : null),
        });
        return;
      }

      const chosenSan = asText(jev.chosenSan) || (record && asText(record.san)) || "?";
      headlineSan.textContent = chosenSan;
      const metaBits = [];
      if (jev.strategyName) metaBits.push(asText(jev.strategyName));
      else if (jev.strategyId) metaBits.push(asText(jev.strategyId));
      if (jev.pipeline) metaBits.push(asText(jev.pipeline));
      if (jev.model) metaBits.push(asText(jev.model));
      headlineMeta.textContent = metaBits.join(" · ");

      // The plan behind the displayed move, or the one in force for the side to move.
      renderPlan(planBody, {
        planned: (jev.llm && jev.llm.plan) || planInForce(game),
        meta: jev.llm || null,
        gameLlm: game ? game.llm : null,
        game,
        color: (record && record.color) || (game ? game.turn : null),
        seatPlans: seatUsesStrategist(game, (record && record.color) || (game ? game.turn : null)),
      });

      const searchRank = Number(jev.searchRankOfChosen);
      const chosenRank = Number(jev.chosenRank);
      if (Number.isFinite(searchRank) && Number.isFinite(chosenRank) && searchRank !== chosenRank) {
        impact.hidden = false;
        impact.textContent =
          `Jev moved ${chosenSan} up from search rank ${searchRank} to rank ${chosenRank}.`;
      } else if (Number.isFinite(chosenRank)) {
        impact.hidden = false;
        impact.textContent = `Chosen at rank ${chosenRank} of the composite ordering.`;
      } else {
        impact.hidden = true;
      }

      // ---- weights
      clear(weightsBody);
      const weights = weightEntries(jev.weights);
      if (weights.length === 0) {
        weightsBox.hidden = true;
      } else {
        weightsBox.hidden = false;
        const max = weights.reduce((acc, w) => Math.max(acc, w.value), 0) || 1;
        for (const weight of weights) {
          const row = el("div", "weight-row");
          row.append(
            el("span", "weight-label", weight.label),
            bar(weight.value / max, "weight", weight.value.toFixed(2)),
          );
          weightsBody.appendChild(row);
        }
      }

      // ---- candidates
      clear(table);
      const rows = candidateRows(jev);
      const keys = dimensionKeys(jev);
      if (rows.length === 0) {
        table.appendChild(el("p", "jev-empty", "Jev did not return a candidate list for this move."));
      } else {
        const head = el("div", "cand-row cand-head");
        head.append(
          el("span", "cand-cell cand-san", "move"),
          el("span", "cand-cell cand-rank", "rank"),
          el("span", "cand-cell cand-choice", "choice"),
          el("span", "cand-cell cand-dims", "dimensions"),
          el("span", "cand-cell cand-composite", "score"),
        );
        table.appendChild(head);

        for (const row of rows) {
          const node = el("button", "cand-row");
          node.type = "button";
          node.dataset.san = row.san;
          if (row.chosen) node.classList.add("cand-chosen");
          if (row.from && row.to) node.dataset.from = row.from;

          const sanCell = el("span", "cand-cell cand-san");
          sanCell.append(el("span", "cand-san-text", row.san));
          if (row.chosen) sanCell.append(el("span", "cand-flag", "chosen"));
          if (row.tags.length) {
            const tags = el("span", "cand-tags");
            for (const tag of row.tags.slice(0, 4)) tags.append(el("span", "tag", tag));
            sanCell.append(tags);
          }

          const rankCell = el("span", "cand-cell cand-rank", row.searchRank === null ? "–" : String(row.searchRank));
          const choiceCell = el("span", "cand-cell cand-choice");
          choiceCell.append(
            row.choiceProb === null
              ? el("span", "cand-muted", "not asked")
              : bar(row.choiceProb, "choice", formatPercent(row.choiceProb)),
          );

          const dimsCell = el("span", "cand-cell cand-dims");
          for (const key of keys) {
            const dim = row.dims.find((d) => d.key === key);
            const value = dim ? dim.value : null;
            const line = el("span", "dim-line");
            line.append(
              el("span", "dim-label", dimensionLabel(key)),
              bar(value === null ? 0 : value, "dim", value === null ? "–" : value.toFixed(2)),
            );
            dimsCell.appendChild(line);
          }

          const compositeCell = el("span", "cand-cell cand-composite");
          compositeCell.textContent = row.composite === null ? "–" : row.composite.toFixed(3);

          node.append(sanCell, rankCell, choiceCell, dimsCell, compositeCell);
          if (row.from && row.to) {
            node.addEventListener("click", () => {
              if (onPreview) onPreview({ from: row.from, to: row.to, san: row.san });
            });
            node.addEventListener("mouseenter", () => {
              if (onPreview) onPreview({ from: row.from, to: row.to, san: row.san, hover: true });
            });
            node.addEventListener("mouseleave", () => {
              if (onPreview) onPreview(null);
            });
          } else {
            node.disabled = true;
          }
          table.appendChild(node);
        }
      }

      // ---- notes
      clear(notesBox);
      const notes = Array.isArray(jev.notes) ? jev.notes.filter((n) => typeof n === "string" && n) : [];
      if (notes.length) {
        notesBox.appendChild(el("h3", "panel-subhead", "Jev's notes"));
        const list = el("ul", "note-list");
        for (const note of notes) list.append(el("li", "note", note));
        notesBox.appendChild(list);
      }

      // ---- audit
      const audit = auditRows(jev.audit);
      if (audit.length) {
        auditBox.hidden = false;
        clear(auditBody);
        for (const entry of audit) {
          const row = el("div", "audit-row");
          row.append(
            el("span", "audit-question", entry.question),
            el("span", "audit-noul", entry.noul === null ? "—" : entry.noul.toFixed(2)),
          );
          if (entry.veto) row.append(el("span", "audit-veto", "veto"));
          auditBody.appendChild(row);
        }
        if (Array.isArray(jev.vetoed) && jev.vetoed.length) {
          const vetoed = el("p", "audit-vetoed", `Vetoed: ${jev.vetoed.join(", ")}`);
          auditBody.appendChild(vetoed);
        }
      } else {
        auditBox.hidden = true;
      }

      // ---- footer: usage / timing / requests
      clear(footer);
      const tokens = formatTokens(jev.usage);
      if (tokens) footer.append(el("span", "jev-stat", tokens));
      const elapsed = Number(jev.elapsedMs);
      if (Number.isFinite(elapsed)) footer.append(el("span", "jev-stat", `${formatSeconds(elapsed)}s`));
      const requests = Number(jev.requests);
      if (Number.isFinite(requests)) {
        footer.append(el("span", "jev-stat", `${requests} request${requests === 1 ? "" : "s"}`));
      }
      const questions = Array.isArray(jev.questionIds) ? jev.questionIds.length : 0;
      if (questions) footer.append(el("span", "jev-stat", `${questions} questions`));
      if (footer.childElementCount === 0) footer.append(el("span", "jev-stat jev-muted", "no usage data"));

      // ---- errors
      clear(errors);
      const problems = Array.isArray(jev.errors) ? jev.errors.filter(Boolean) : [];
      if (problems.length) {
        errors.hidden = false;
        errors.append(el("h3", "panel-subhead", "Notes from the Jev call"));
        const list = el("ul", "error-list");
        for (const problem of problems) {
          list.append(el("li", "error-item", typeof problem === "string" ? problem : JSON.stringify(problem)));
        }
        errors.appendChild(list);
      } else {
        errors.hidden = true;
      }
    },
  };
}

/* ------------------------------------------------------------- move list */

/** Numbered two-column SAN list; clicking a ply previews that position. */
export function createMoveList(root) {
  root.classList.add("move-list");
  const head = el("div", "panel-head");
  const title = el("h2", "panel-title", "Moves");
  const historyBadge = el("span", "history-badge", "viewing history");
  historyBadge.hidden = true;
  const liveButton = el("button", "link-button", "back to live");
  liveButton.type = "button";
  liveButton.hidden = true;
  head.append(title, historyBadge, liveButton);

  const body = el("div", "move-rows");
  const empty = el("p", "panel-empty", "No moves yet.");
  root.append(head, body, empty);

  let onPreview = null;
  liveButton.addEventListener("click", () => {
    if (onPreview) onPreview(null);
  });

  const rowNodes = [];

  return {
    el: root,
    setPreviewHandler(fn) {
      onPreview = typeof fn === "function" ? fn : null;
    },
    /**
     * @param {Array} history MoveRecord[]
     * @param {object} options { currentPly, previewPly, live }
     */
    update(history, options = {}) {
      const rows = pairMoves(history);
      const currentPly = Number.isFinite(Number(options.currentPly)) ? Number(options.currentPly) : rows.length * 2;
      const previewPly =
        options.previewPly === null || options.previewPly === undefined ? null : Number(options.previewPly);
      rowNodes.length = 0;
      body.replaceChildren();

      empty.hidden = rows.length > 0;
      for (const row of rows) {
        const node = el("div", "move-row");
        node.append(el("span", "move-number", `${row.moveNumber}.`));
        for (const side of ["white", "black"]) {
          const record = row[side];
          if (!record) {
            const placeholder = el("span", "move-san move-san-empty", side === "black" ? "\u2026" : "");
            node.append(placeholder);
            rowNodes.push(null);
            continue;
          }
          const ply = Number(record.ply);
          const button = el("button", "move-san");
          button.type = "button";
          button.textContent = asText(record.san, "?");
          button.dataset.ply = String(Number.isFinite(ply) ? ply : rowNodes.length + 1);
          button.title = formatMoveLabel(ply, record.san, record.color);
          if (record.check) button.classList.add("move-check");
          if (record.mate) button.classList.add("move-mate");
          if (record.by === "jev") button.classList.add("move-jev");
          const plyNumber = Number.isFinite(ply) ? ply : rowNodes.length + 1;
          if (previewPly !== null && plyNumber === previewPly) button.classList.add("move-selected");
          else if (previewPly === null && plyNumber === currentPly) button.classList.add("move-current");
          button.addEventListener("click", () => {
            if (onPreview) onPreview(plyNumber);
          });
          node.append(button);
          rowNodes.push(button);
        }
        body.appendChild(node);
      }

      const viewing = previewPly !== null;
      historyBadge.hidden = !viewing;
      liveButton.hidden = !viewing;
      root.classList.toggle("is-previewing", viewing);

      const last = body.lastElementChild;
      if (last && typeof last.scrollIntoView === "function") {
        last.scrollIntoView({ block: "nearest" });
      }
    },
  };
}

/* --------------------------------------------------------------- banners */

/**
 * Dismissible banner: shown while `game.jev.hasApiKey === false`.
 * Never blocks play — it is a hint, not a gate.
 */
export function createBanner(root) {
  root.classList.add("banner");
  root.hidden = true;
  const text = el("p", "banner-text", "");
  const dismiss = el("button", "banner-dismiss", "\u00d7");
  dismiss.type = "button";
  dismiss.setAttribute("aria-label", "Dismiss this notice");
  root.append(text, dismiss);

  let dismissed = false;
  dismiss.addEventListener("click", () => {
    dismissed = true;
    root.hidden = true;
  });

  return {
    el: root,
    update(game) {
      const jev = game && game.jev && typeof game.jev === "object" ? game.jev : null;
      const missing = !!jev && jev.hasApiKey === false;
      if (!missing) dismissed = false; // a fresh game with a key re-arms nothing
      if (!missing || dismissed) {
        root.hidden = true;
        return;
      }
      root.hidden = false;
      const message =
        "Jev has no API key, so the server is playing with its mock provider. " +
        "Put TYPESAFE_API_KEY=... in .env and restart to hand the decisions to the real Jev. " +
        "The game is fully playable either way.";
      text.textContent = message;
      root.dataset.tone = "info";
    },
  };
}

/* ---------------------------------------------------------------- toasts */

export function createToasts(root) {
  root.classList.add("toast-stack");
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  const timers = new Set();

  return {
    el: root,
    /** @param {"info"|"warn"|"error"} level @param {string} message */
    push(level, message) {
      const tone = level === "warn" || level === "error" ? level : "info";
      const toast = el("div", `toast toast-${tone}`);
      toast.append(el("span", "toast-text", asText(message, "…")));
      const close = el("button", "toast-close", "\u00d7");
      close.type = "button";
      close.setAttribute("aria-label", "Dismiss");
      toast.appendChild(close);
      root.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add("toast-in"));

      const remove = () => {
        toast.classList.remove("toast-in");
        window.setTimeout(() => toast.remove(), 200);
      };
      close.addEventListener("click", remove);
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        remove();
      }, tone === "error" ? 9000 : 5200);
      timers.add(timer);
    },
    clear() {
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      root.replaceChildren();
    },
  };
}

/* ---------------------------------------------------------- helpers for app */

/** Build the clock-rendering context used by `createPlayerCard`. */
export function clockContext(game, localNow, offset) {
  const clocks = game && game.clocks && typeof game.clocks === "object" ? game.clocks : null;
  if (!clocks) return { w: null, b: null, running: null };
  return {
    w: clockRemaining(clocks, "w", localNow, offset),
    b: clockRemaining(clocks, "b", localNow, offset),
    running: clocks.running === "w" || clocks.running === "b" ? clocks.running : null,
  };
}

export { el as createElement };

/* ------------------------------------------------------- the strategy layer */

/** Does the seat that produced this move plan with a reasoning model? */
function seatUsesStrategist(game, color) {
  if (!game || !game.players || (color !== "w" && color !== "b")) return true;
  const seat = game.players[color];
  return seat ? seat.usesStrategist === true : true;
}

/** The plan in force for whichever seat has the move, from the game snapshot. */function planInForce(game) {
  const plans = game && game.llm && game.llm.plans ? game.llm.plans : null;
  if (!plans) return null;
  const turn = game && (game.turn === "w" || game.turn === "b") ? game.turn : null;
  const plan = turn ? plans[turn] : null;
  return plan && plan.plan ? plan : plans.w || plans.b || null;
}

/**
 * Render the plan block. Three states matter to a watcher:
 *  - a plan in force, with what it changed and what it cost;
 *  - a seat that wants to plan but has no key (said plainly, with the command);
 *  - a strategist that failed (the reason, not silence).
 */
/**
 * What the plan has actually done to this seat's moves so far, counted from the move records.
 *
 * This exists because "the plan is in force" is not the same as "the plan changed anything": a
 * plan can be applied and every move still be the search's own first choice. These are the
 * numbers that separate the two, and they are all code-computed from the records — no model
 * grades itself. The centipawn figure is against *this game's own* search depth, so it says
 * what the plan cost by the measure the move was actually chosen with, not ground truth.
 * Implementation lives in logic.js so it can be unit-tested without a DOM.
 */

function renderPlan(container, { planned, meta, gameLlm, game = null, color = null, seatPlans = true } = {}) {
  if (!container) return;
  clear(container);
  const llm = gameLlm && typeof gameLlm === "object" ? gameLlm : null;
  const plan = planned && typeof planned === "object" && planned.plan ? planned : null;

  const heading = el("div", "jev-plan-head");
  heading.appendChild(el("span", "jev-plan-kind", plan ? asText(plan.label || plan.plan) : "No plan in force"));
  const badges = el("div", "jev-plan-badges");
  if (llm && llm.model) badges.appendChild(el("span", "badge badge-quiet", asText(llm.model)));
  if ((llm && llm.mock) || (meta && meta.mock)) badges.appendChild(el("span", "badge badge-mock", "Mock strategist"));
  if (llm && llm.configured === false) badges.appendChild(el("span", "badge badge-warn", "No strategist key"));
  if (badges.childNodes.length > 0) heading.appendChild(badges);
  container.appendChild(heading);

  if (!plan) {
    const reason = !seatPlans
      ? "This seat judges with Jev only and has no planner — pick the Strategist preset to give it one."
      : llm && llm.configured === false
        ? "This seat plans, but no Gemini key is configured — run `npm run key:set -- gemini` and restart."
        : llm && llm.lastError
          ? `The strategist could not be used: ${asText(llm.lastError)}`
          : "No plan yet — the strategist is asked on this seat's first move.";
    container.appendChild(el("p", "jev-plan-empty", reason));
    return;
  }

  const facts = el("div", "jev-plan-facts");
  const targets = Array.isArray(plan.targets) ? plan.targets : [];
  if (targets.length > 0) {
    for (const square of targets) facts.appendChild(el("span", "chip chip-target", asText(square)));
  } else {
    facts.appendChild(el("span", "chip", "no target square"));
  }
  facts.appendChild(el("span", "chip", `risk ${asText(plan.risk)}`));
  if (Number.isFinite(Number(plan.reviewAfterPlies))) facts.appendChild(el("span", "chip", `review every ${Number(plan.reviewAfterPlies)} plies`));
  if (plan.opponentPlan) facts.appendChild(el("span", "chip", `opponent: ${asText(plan.opponentPlan)}`));
  container.appendChild(facts);

  const shifts = meta && meta.applied && meta.applied.weights ? Object.entries(meta.applied.weights) : [];
  const dims = meta && meta.applied && Array.isArray(meta.applied.dims) ? meta.applied.dims : [];
  const lines = [];
  if (shifts.length > 0) {
    lines.push(`Weights shifted: ${shifts.map(([key, delta]) => `${key} ${delta > 0 ? "+" : ""}${Number(delta).toFixed(2)}`).join(", ")}`);
  }
  if (dims.length > 0) lines.push(`Jev asked about: ${dims.join(", ")}`);
  if (meta && meta.reason) lines.push(`Review trigger: ${asText(meta.reason)}`);
  for (const line of lines) container.appendChild(el("p", "jev-plan-line", line));

  if (plan.commentary) container.appendChild(el("p", "jev-plan-commentary", asText(plan.commentary)));

  // "In force" is not the same as "had an effect": count it.
  const tally = game ? strategyTally(game, color) : null;
  if (tally) {
    const parts = [`${tally.planned} of ${tally.moves} move${tally.moves === 1 ? "" : "s"} played under a plan`];
    if (tally.deviated > 0) {
      parts.push(`${tally.deviated} differed from the search's own first choice`);
      if (tally.meanCp !== null) {
        parts.push(`${tally.meanCp >= 0 ? "+" : ""}${tally.meanCp.toFixed(0)} cp on average${tally.depth ? ` at depth ${tally.depth}` : ""}`);
      }
    } else {
      parts.push("none differed from the search's own first choice yet");
    }
    parts.push(`${tally.reviews} review${tally.reviews === 1 ? "" : "s"} so far`);
    container.appendChild(el("p", "jev-plan-tally", parts.join(" · ")));
  }

  const footerBits = [];
  if (meta && meta.thinkingLevel) footerBits.push(`thinking ${asText(meta.thinkingLevel)}`);
  if (meta && meta.api) footerBits.push(`${asText(meta.api)} API`);
  if (meta && Number.isFinite(Number(meta.elapsedMs))) footerBits.push(`${(Number(meta.elapsedMs) / 1000).toFixed(1)}s`);
  if (meta && meta.usage) {
    const { inputTokens = 0, outputTokens = 0, thoughtTokens = 0 } = meta.usage;
    footerBits.push(`${inputTokens} in / ${outputTokens} out${thoughtTokens ? ` / ${thoughtTokens} thought` : ""}`);
  }
  if (meta && typeof meta.costUsd === "number") footerBits.push(`$${meta.costUsd.toFixed(5)}`);
  if (llm && Number.isFinite(Number(llm.reviews)) && llm.reviews > 0) footerBits.push(`${llm.reviews} review${llm.reviews === 1 ? "" : "s"} this game`);
  if (llm && Number.isFinite(Number(llm.costUsd)) && llm.costUsd > 0) footerBits.push(`$${Number(llm.costUsd).toFixed(4)} total`);
  if (footerBits.length > 0) container.appendChild(el("p", "jev-plan-meta", footerBits.join(" · ")));

  for (const note of (meta && meta.notes) || []) container.appendChild(el("p", "jev-plan-note", asText(note)));
  for (const problem of (meta && meta.problems) || []) container.appendChild(el("p", "jev-plan-problem", asText(problem)));
}
