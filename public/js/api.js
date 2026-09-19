/**
 * api.js — REST + SSE client for the frozen JevChess contract.
 *
 * The API key lives on the server only: nothing in this file (or anywhere under
 * `public/`) may talk to a third-party host. Every request is same-origin and
 * relative to the page, so the app works behind any host/port the server picks.
 */

/** Error carrying the contract's `error.code` / `error.message` pair. */
export class ApiError extends Error {
  constructor(message, { code = "network", status = 0, cause = null } = {}) {
    super(message || "Request failed");
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

/** Contract error codes → the tone the UI should use for the toast. */
export function toneForErrorCode(code) {
  if (code === "jev-unavailable" || code === "jev-error") return "warn";
  if (code === "bad-request" || code === "not-found") return "error";
  return "error";
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class JevChessApi {
  /**
   * @param {string} [base] base URL; "" (default) means "same origin".
   */
  constructor(base = "") {
    this.base = typeof base === "string" ? base.replace(/\/+$/, "") : "";
  }

  url(path) {
    const suffix = typeof path === "string" && path.startsWith("/") ? path : `/${path}`;
    return `${this.base}${suffix}`;
  }

  /** Raw JSON request. Never throws on a malformed body — only on transport. */
  async request(path, { method = "GET", body, signal } = {}) {
    const init = {
      method,
      headers: { Accept: "application/json" },
      cache: "no-store",
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (signal) init.signal = signal;

    let response;
    try {
      response = await fetch(this.url(path), init);
    } catch (cause) {
      if (cause && cause.name === "AbortError") throw cause;
      throw new ApiError("Could not reach the JevChess server.", { code: "network", cause });
    }

    let payload = null;
    const text = await response.text().catch(() => "");
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const error = isPlainObject(payload) && isPlainObject(payload.error) ? payload.error : {};
      throw new ApiError(
        typeof error.message === "string" && error.message
          ? error.message
          : `Request failed (HTTP ${response.status}).`,
        {
          code: typeof error.code === "string" ? error.code : "http-error",
          status: response.status,
        },
      );
    }
    return payload;
  }

  /** GET /api/health -> `{ ok, model, hasApiKey, mock, version, serverTime }` */
  health(options) {
    return this.request("/api/health", options);
  }

  /** GET /api/strategies -> `{ presets, sliders, pipelines }` */
  strategies(options) {
    return this.request("/api/strategies", options);
  }

  /** POST /api/games -> `{ game }` */
  createGame(newGameRequest, options = {}) {
    return this.request("/api/games", { ...options, method: "POST", body: newGameRequest || {} });
  }

  /** GET /api/games/:id -> `{ game }` */
  getGame(id, options) {
    return this.request(`/api/games/${encodeURIComponent(String(id))}`, options);
  }

  /** POST /api/games/:id/moves -> `{ game }` */
  playMove(id, move, options = {}) {
    return this.request(`/api/games/${encodeURIComponent(String(id))}/moves`, {
      ...options,
      method: "POST",
      body: move || {},
    });
  }

  /** POST /api/games/:id/undo -> `{ game }` */
  undo(id, options = {}) {
    return this.request(`/api/games/${encodeURIComponent(String(id))}/undo`, {
      ...options,
      method: "POST",
      body: {},
    });
  }

  /** POST /api/games/:id/resign -> `{ game }` */
  resign(id, color, options = {}) {
    return this.request(`/api/games/${encodeURIComponent(String(id))}/resign`, {
      ...options,
      method: "POST",
      body: color ? { color } : {},
    });
  }

  /** POST /api/games/:id/draw -> `{ game }` */
  draw(id, action, options = {}) {
    return this.request(`/api/games/${encodeURIComponent(String(id))}/draw`, {
      ...options,
      method: "POST",
      body: { action: action || "offer" },
    });
  }

  /** POST /api/games/:id/autoplay -> `{ game }` */
  autoplay(id, running, options = {}) {
    return this.request(`/api/games/${encodeURIComponent(String(id))}/autoplay`, {
      ...options,
      method: "POST",
      body: { running: running === true },
    });
  }

  /** POST /api/games/:id/step -> `{ game }` */
  step(id, options = {}) {
    return this.request(`/api/games/${encodeURIComponent(String(id))}/step`, {
      ...options,
      method: "POST",
      body: {},
    });
  }

  /** POST /api/games/:id/players -> `{ game }` */
  setPlayers(id, players, options = {}) {
    return this.request(`/api/games/${encodeURIComponent(String(id))}/players`, {
      ...options,
      method: "POST",
      body: players || {},
    });
  }

  /**
   * Subscribe to `/api/games/:id/events` (SSE).
   *
   * Events emitted (all with a `serverTime` first argument):
   *   "state"       (serverTime, game)
   *   "ai-thinking" (serverTime, payload)
   *   "ai-result"   (serverTime, payload)
   *   "notice"      (serverTime, payload)
   *   "game-over"   (serverTime, payload)
   *   "open"        (serverTime)          — the stream connected / reconnected
   *   "error"       (serverTime, info)    — the stream dropped; EventSource retries
   *   "unsupported" (serverTime, info)    — EventSource is unavailable
   *
   * @returns {() => void} disposer
   */
  subscribe(id, handlers = {}) {
    const on = (name, fn) => {
      if (typeof fn === "function") handlers[name] = fn;
    };
    on("state", handlers.state);
    on("ai-thinking", handlers.aiThinking);
    on("ai-result", handlers.aiResult);
    on("notice", handlers.notice);
    on("game-over", handlers.gameOver);
    on("open", handlers.open);
    on("error", handlers.error);
    on("unsupported", handlers.unsupported);

    const emit = (name, ...args) => {
      const fn = handlers[name];
      if (typeof fn === "function") {
        try {
          fn(...args);
        } catch (error) {
          // A broken listener must not take the SSE plumbing down with it.
          if (typeof handlers.onListenerError === "function") handlers.onListenerError(error);
        }
      }
    };

    if (typeof EventSource !== "function") {
      emit("unsupported", { message: "This browser does not support EventSource." });
      return () => {};
    }

    const source = new EventSource(this.url(`/api/games/${encodeURIComponent(String(id))}/events`));
    let closed = false;
    let sawOpen = false;

    const parse = (event) => {
      try {
        const payload = JSON.parse(event.data);
        return isPlainObject(payload) ? payload : {};
      } catch {
        return {};
      }
    };

    const dispatch = (name, handler) => {
      source.addEventListener(name, (event) => {
        const payload = parse(event);
        const serverTime = Number.isFinite(Number(payload.serverTime)) ? Number(payload.serverTime) : Date.now();
        handler(serverTime, payload);
      });
    };

    dispatch("state", (serverTime, payload) => emit("state", serverTime, payload.game || null));
    dispatch("ai-thinking", (serverTime, payload) => emit("ai-thinking", serverTime, payload));
    dispatch("ai-result", (serverTime, payload) => emit("ai-result", serverTime, payload));
    dispatch("notice", (serverTime, payload) => emit("notice", serverTime, payload));
    dispatch("game-over", (serverTime, payload) => emit("game-over", serverTime, payload));

    source.addEventListener("open", () => {
      if (closed) return;
      const first = !sawOpen;
      sawOpen = true;
      emit("open", Date.now(), { first });
    });

    source.addEventListener("error", (event) => {
      if (closed) return;
      emit("error", Date.now(), {
        readyState: source.readyState,
        // readyState 2 === CLOSED: the browser will not retry by itself.
        fatal: source.readyState === 2,
        event,
      });
    });

    return () => {
      closed = true;
      try {
        source.close();
      } catch {
        /* already closed */
      }
    };
  }
}

export default JevChessApi;
