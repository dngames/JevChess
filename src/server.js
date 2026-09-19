/**
 * HTTP + SSE server. Zero dependencies: node:http, node:fs, node:path.
 *
 * Responsibilities:
 *  - serve the UI from public/
 *  - keep one Game per id and expose it over REST (see CONTRACT.md)
 *  - push every state change over Server-Sent Events so the board animates itself
 *  - keep the TypeSafe API key on this side of the wire, always
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv, describeApiKey } from "./env.js";
import { resolveApiKey } from "./win-key.js";
import { createJevClient } from "./jev/client.js";
import { Game } from "./game.js";
import { strategiesPayload, getPreset, DEFAULT_STRATEGY_ID } from "./strategies.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC_DIR = join(ROOT, "public");
const MAX_BODY_BYTES = 256 * 1024;
const HEARTBEAT_MS = 15_000;
const MAX_GAMES = 50;

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

loadDotEnv(join(ROOT, ".env"));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const MODEL = process.env.TYPESAFE_MODEL ?? "jev-latest";
const FORCE_MOCK = ["1", "true", "yes"].includes(String(process.env.JEV_MOCK ?? "").toLowerCase());
const VERSION = await readVersion();

// Environment/.env first (a shell variable overrides), then Windows secure storage.
// resolveApiKey never throws: a missing or unreadable stored key just means mock play.
const { key: API_KEY, source: KEY_SOURCE } = await resolveApiKey();

const jevClient = createJevClient({
  apiKey: API_KEY,
  forceMock: FORCE_MOCK,
  model: MODEL,
  onLog: (entry) => {
    if (entry.event === "jev-error") console.warn(`[jev] ${entry.code ?? "error"}: ${entry.message ?? ""}`);
  },
});

/** @type {Map<string, {game: Game, sse: Set<import("node:http").ServerResponse>}>} */
const sessions = new Map();

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error("[server] unhandled", error);
    if (!res.headersSent) sendJson(res, 500, { error: { code: "internal", message: "Something went wrong on the server." } });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`JevChess ${VERSION} listening on ${url}`);
  console.log(`  model:   ${MODEL}`);
  console.log(`  api key: ${describeApiKey(API_KEY)} — from ${KEY_SOURCE}${jevClient.mock ? "  → running MOCK Jev (deterministic answers, not real chess judgement)" : ""}`);
  console.log(`  strategies: ${strategiesPayload().presets.length} presets; default ${DEFAULT_STRATEGY_ID}`);
  console.log(`  open ${url} in your browser.`);
});

const heartbeat = setInterval(() => {
  for (const session of sessions.values()) {
    for (const client of session.sse) {
      try {
        client.write(": ping\n\n");
      } catch {
        session.sse.delete(client);
      }
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n${signal}: shutting down.`);
    clearInterval(heartbeat);
    for (const session of sessions.values()) {
      session.game.dispose();
      for (const client of session.sse) client.end();
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref?.();
  });
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (path === "/api/health" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      model: MODEL,
      hasApiKey: Boolean(API_KEY),
      mock: Boolean(jevClient.mock),
      games: sessions.size,
      serverTime: Date.now(),
    });
  }

  if (path === "/api/strategies" && req.method === "GET") {
    return sendJson(res, 200, { ...strategiesPayload(), serverTime: Date.now() });
  }

  if (path === "/api/games" && req.method === "POST") {
    const body = await readJson(req);
    if (body.error) return sendJson(res, 400, body.error);
    const created = createGame(body.value ?? {});
    if (created.error) return sendJson(res, 400, created.error);
    return sendJson(res, 201, { game: created.session.game.snapshot(), serverTime: Date.now() });
  }

  const gameMatch = path.match(/^\/api\/games\/([A-Za-z0-9_-]+)(\/[a-z-]+)?$/);
  if (gameMatch) {
    const session = sessions.get(gameMatch[1]);
    if (!session) return sendJson(res, 404, { error: { code: "not-found", message: "That game does not exist (the server may have restarted)." } });
    const action = gameMatch[2] ?? "";
    return handleGameRoute(req, res, session, action);
  }

  if (path.startsWith("/api/")) {
    return sendJson(res, 404, { error: { code: "not-found", message: `No API route for ${req.method} ${path}.` } });
  }

  return serveStatic(req, res, path);
}

async function handleGameRoute(req, res, session, action) {
  const { game } = session;
  const method = req.method ?? "GET";

  if (action === "/events" && method === "GET") return openEventStream(req, res, session);

  if (action === "" && method === "GET") return sendJson(res, 200, { game: game.snapshot(), serverTime: Date.now() });

  if (method !== "POST") {
    return sendJson(res, 405, { error: { code: "bad-request", message: `${method} is not supported here.` } });
  }

  const body = action === "/undo" || action === "/step" ? { value: {} } : await readJson(req);
  if (body.error) return sendJson(res, 400, body.error);
  const input = body.value ?? {};

  let result;
  switch (action) {
    case "/moves":
      result = game.submitHumanMove(input.san ? String(input.san) : { from: input.from, to: input.to, promotion: input.promotion ?? undefined });
      break;
    case "/undo":
      result = game.undo();
      break;
    case "/resign":
      result = game.resign(input.color ?? game.humanColor ?? game.snapshot().turn);
      break;
    case "/draw": {
      const color = input.color ?? game.humanColor;
      if (!color) result = { ok: false, code: "bad-request", message: "Say which side is offering the draw." };
      else if (input.action === "accept") result = game.acceptDraw(color);
      else if (input.action === "decline") result = game.declineDraw(color);
      else result = await game.offerDraw(color);
      break;
    }
    case "/autoplay":
      result = game.setAutoplay(input.running !== false);
      break;
    case "/step":
      if (game.isOver) result = { ok: false, code: "game-over", message: "This game is over." };
      else if (game.players[game.snapshot().turn].kind !== "jev") {
        result = { ok: false, code: "not-your-turn", message: "That seat is played by a human." };
      } else {
        game.kickAi();
        result = { ok: true };
      }
      break;
    case "/players": {
      const updates = [];
      for (const color of ["w", "b"]) {
        if (input[color]) updates.push(game.setPlayer(color, input[color]));
      }
      result = updates.find((entry) => entry && entry.ok === false) ?? { ok: true };
      break;
    }
    default:
      return sendJson(res, 404, { error: { code: "not-found", message: `No such action: ${action}` } });
  }

  if (!result) result = { ok: true };
  if (!result.ok) {
    const status = result.code === "not-found" ? 404 : result.code === "bad-request" ? 400 : 409;
    return sendJson(res, status, { error: { code: result.code ?? "error", message: result.message ?? "Request rejected." } });
  }
  return sendJson(res, 200, { game: game.snapshot(), serverTime: Date.now(), result: { accepted: result.accepted ?? null, pending: result.pending ?? null } });
}

// ---------------------------------------------------------------------------
// games
// ---------------------------------------------------------------------------

function createGame(config) {
  const mode = config.mode === "jev-vs-jev" ? "jev-vs-jev" : "human-vs-jev";
  const humanColor = config.humanColor === "b" ? "b" : "w";

  let chessProbe = null;
  if (config.fen && String(config.fen).trim()) {
    try {
      chessProbe = new Game({
        id: "probe",
        mode,
        humanColor,
        fen: String(config.fen),
        jevClient,
        modelName: MODEL,
        hasApiKey: Boolean(API_KEY),
      });
      chessProbe.dispose();
    } catch (error) {
      return { error: { error: { code: "bad-request", message: `That FEN could not be loaded: ${error.message}` } } };
    }
  }

  const timeControl = normaliseTimeControl(config.timeControl);
  if (timeControl === false) {
    return { error: { error: { code: "bad-request", message: "Time control must be null or { initialMs, incrementMs } with sane values." } } };
  }

  const playerConfigs = {};
  for (const color of ["w", "b"]) {
    const config_ = config.players?.[color];
    if (!config_) continue;
    const strategyId = config_.strategyId ?? DEFAULT_STRATEGY_ID;
    if (!getPreset(strategyId)) {
      return { error: { error: { code: "bad-request", message: `Unknown strategy "${strategyId}".` } } };
    }
    playerConfigs[color] = { strategyId, weights: config_.weights };
  }

  // Keep memory bounded: drop the oldest finished games first.
  if (sessions.size >= MAX_GAMES) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].game.createdAt - b[1].game.createdAt)[0];
    if (oldest) {
      oldest[1].game.dispose();
      for (const client of oldest[1].sse) client.end();
      sessions.delete(oldest[0]);
    }
  }

  const id = `g_${Math.random().toString(36).slice(2, 8)}`;
  const game = new Game({
    id,
    mode,
    humanColor,
    fen: config.fen,
    timeControl,
    playerConfigs,
    jevClient,
    modelName: MODEL,
    hasApiKey: Boolean(API_KEY),
  });

  const session = { game, sse: new Set() };
  sessions.set(id, session);
  game.subscribe((event, payload) => broadcast(session, event, payload));
  return { session };
}

function broadcast(session, event, payload) {
  if (session.sse.size === 0) return;
  const data = JSON.stringify({ serverTime: Date.now(), ...payload });
  for (const client of session.sse) {
    try {
      client.write(`event: ${event}\ndata: ${data}\n\n`);
    } catch {
      session.sse.delete(client);
    }
  }
}

function normaliseTimeControl(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") return false;
  const initialMs = Number(input.initialMs);
  const incrementMs = Number(input.incrementMs ?? 0);
  if (!Number.isFinite(initialMs) || initialMs < 10_000 || initialMs > 3 * 60 * 60 * 1000) return false;
  if (!Number.isFinite(incrementMs) || incrementMs < 0 || incrementMs > 60_000) return false;
  return { initialMs: Math.round(initialMs), incrementMs: Math.round(incrementMs) };
}

function openEventStream(req, res, session) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");
  session.sse.add(res);
  res.write(`event: state\ndata: ${JSON.stringify({ serverTime: Date.now(), game: session.game.snapshot() })}\n\n`);

  const cleanup = () => session.sse.delete(res);
  req.on("close", cleanup);
  req.on("error", cleanup);
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(req, res, path) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: { code: "bad-request", message: "Only GET is supported for static files." } });
  }
  const requested = path === "/" ? "/index.html" : path;
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const target = join(PUBLIC_DIR, safe);
  if (!target.startsWith(PUBLIC_DIR + sep) && target !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: { code: "bad-request", message: "Path escapes the public directory." } });
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) return sendJson(res, 404, { error: { code: "not-found", message: "Not found." } });
    const body = await readFile(target);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": body.length,
      // Development server: never let the browser hold on to a stale build.
      "Cache-Control": "no-store",
    });
    return res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    if (!existsSync(target) && !extname(target)) {
      // Unknown extension-less path: hand back the app shell.
      try {
        const shell = await readFile(join(PUBLIC_DIR, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(shell);
      } catch {
        /* fall through */
      }
    }
    return sendJson(res, 404, { error: { code: "not-found", message: `No such file: ${path}` } });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolvePromise) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolvePromise({ error: { error: { code: "bad-request", message: "Request body too large." } } });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolvePromise({ value: {} });
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") {
          return resolvePromise({ error: { error: { code: "bad-request", message: "Request body must be a JSON object." } } });
        }
        return resolvePromise({ value: parsed });
      } catch {
        return resolvePromise({ error: { error: { code: "bad-request", message: "Request body is not valid JSON." } } });
      }
    });
    req.on("error", () => resolvePromise({ error: { error: { code: "bad-request", message: "Request stream failed." } } }));
  });
}

async function readVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export { server, createGame, sessions };
