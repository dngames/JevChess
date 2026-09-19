/**
 * Server smoke test: drives the running JevChess server over HTTP + SSE.
 *
 * Run the server first (`npm start`), then: node tools/smoke.mjs [baseUrl]
 *
 * This exercises the real wire format the browser uses: REST snapshots, a human move,
 * an AI reply, strategy switching, error codes, and a live SSE stream. It works with
 * either a real Jev key or the built-in mock (a missing key switches the server to mock
 * automatically), and it reports which one it found.
 */

const BASE = (process.argv[2] ?? process.env.JEVCHESS_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON (static file) */
  }
  return { status: response.status, json, text, headers: response.headers };
}

async function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 120 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await api(`/api/games/${currentGameId}`);
    if (predicate(last.json?.game)) return last.json.game;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last?.json?.game ?? null;
}

let currentGameId = null;

// ---------------------------------------------------------------------------

console.log(`JevChess smoke test against ${BASE}\n`);

const health = await api("/api/health");
check("GET /api/health returns 200", health.status === 200, `status ${health.status}`);
check("health reports a version", typeof health.json?.version === "string");
check("health reports the model", typeof health.json?.model === "string", JSON.stringify(health.json?.model));
check("health reports whether a key is present", typeof health.json?.hasApiKey === "boolean");
console.log(
  `  info  model=${health.json?.model} key=${health.json?.hasApiKey ? "present" : "missing (mock Jev)"} mock=${health.json?.mock} version=${health.json?.version}\n`,
);

// --- static files ----------------------------------------------------------

const index = await api("/");
check("GET / serves the app shell", index.status === 200 && /<html/i.test(index.text));
check("the shell loads app.js as a module", /type="module"[^>]*src="\/js\/app\.js"|src="\/js\/app\.js"[^>]*type="module"/.test(index.text));

const appJs = await api("/js/app.js");
check("GET /js/app.js serves JavaScript", appJs.status === 200 && /javascript/i.test(appJs.headers.get("content-type") ?? ""));
const css = await api("/style.css");
check("GET /style.css serves CSS", css.status === 200 && /css/i.test(css.headers.get("content-type") ?? ""));
const traversal = await api("/../package.json");
check("path traversal is refused", traversal.status !== 200 || !traversal.text.includes('"name": "jev-chess"'));
const missingApi = await api("/api/nope");
check("unknown API routes return JSON 404", missingApi.status === 404 && missingApi.json?.error?.code === "not-found");

// --- strategies ------------------------------------------------------------

const strategies = await api("/api/strategies");
check("GET /api/strategies returns 200", strategies.status === 200);
const presets = strategies.json?.presets ?? [];
check("there are at least six presets", presets.length >= 6, `${presets.length}`);
check("exactly one preset is marked best and it is balanced", presets.filter((preset) => preset.best).length === 1 && presets.find((p) => p.best)?.id === "balanced");
check("sliders are described for the UI", (strategies.json?.sliders ?? []).length >= 5);
check("pipelines are described", (strategies.json?.pipelines ?? []).length >= 4);
check("every preset names its pipeline", presets.every((preset) => typeof preset.pipeline === "string"));

// --- bad requests ----------------------------------------------------------

const badMode = await api("/api/games", { method: "POST", body: { mode: "human-vs-jev", fen: "not a fen" } });
check("an invalid FEN is rejected with 400", badMode.status === 400, `status ${badMode.status}`);
const unknownStrategy = await api("/api/games", { method: "POST", body: { players: { b: { strategyId: "nope" } } } });
check("an unknown strategy is rejected with 400", unknownStrategy.status === 400);

// --- a human-vs-Jev game over the wire -------------------------------------

const created = await api("/api/games", {
  method: "POST",
  body: {
    mode: "human-vs-jev",
    humanColor: "w",
    timeControl: { initialMs: 300_000, incrementMs: 2_000 },
    players: { b: { strategyId: "code-only" } },
  },
});
check("POST /api/games creates a game", created.status === 201 && Boolean(created.json?.game?.id), `status ${created.status}`);
const game = created.json.game;
currentGameId = game.id;

check("the snapshot carries a board of 64 cells", Array.isArray(game.board) && game.board.length === 64);
check("the snapshot carries legal moves for the side to move", game.legalMoves.length === 20, `${game.legalMoves.length}`);
check("the snapshot carries clocks", game.clocks?.w === 300_000 && game.clocks?.incrementMs === 2_000);
check("the black seat is the code-only baseline", game.players.b.strategyId === "code-only");
check("the white seat is the human", game.players.w.kind === "human");
check("serverTime is included for clock interpolation", typeof created.json.serverTime === "number");

const illegal = await api(`/api/games/${game.id}/moves`, { method: "POST", body: { from: "e2", to: "e5" } });
check("an illegal move returns 409 illegal-move", illegal.status === 409 && illegal.json?.error?.code === "illegal-move", JSON.stringify(illegal.json?.error));

const wrongTurn = await api(`/api/games/${game.id}/moves`, { method: "POST", body: { from: "e7", to: "e5" } });
check("moving out of turn is refused", wrongTurn.status === 409, `status ${wrongTurn.status}`);

const humanMove = await api(`/api/games/${game.id}/moves`, { method: "POST", body: { from: "e2", to: "e4" } });
check("a legal human move is accepted", humanMove.status === 200 && humanMove.json.game.history.length === 1);
check("after the human move it is Black's turn", humanMove.json.game.turn === "b");

const afterAi = await waitFor((state) => state.history.length >= 2, { timeoutMs: 20_000 });
check("the AI seat replies on its own", afterAi?.history?.length >= 2, `history ${afterAi?.history?.length}`);
check("the AI reply is recorded as a Jev move", afterAi?.history?.[1]?.by === "jev");
check("the AI reply carries a move record", Boolean(afterAi?.history?.[1]?.jev), "no jev record");
check("the move record names a chosen move", typeof afterAi?.history?.[1]?.jev?.chosenSan === "string");
check("the move record lists candidates with composite scores", (afterAi?.history?.[1]?.jev?.candidates ?? []).every((candidate) => typeof candidate.composite === "number"));
check("the record says which pipeline ran", typeof afterAi?.history?.[1]?.jev?.pipeline === "string");
check("the eval bar is present and bounded", afterAi?.evalBar?.whiteWinProb > 0 && afterAi?.evalBar?.whiteWinProb < 1);

// --- undo, strategy switch, SSE, draw, resign ------------------------------

const undo = await api(`/api/games/${game.id}/undo`, { method: "POST" });
check("undo takes back the pair", undo.status === 200 && undo.json.game.history.length === 0, `history ${undo.json?.game?.history?.length}`);
check("undo restores the starting position", undo.json?.game?.fen === undo.json?.game?.startFen);

const switchSeat = await api(`/api/games/${game.id}/players`, { method: "POST", body: { b: { strategyId: "attacking", weights: { kingPressure: 0.9 } } } });
check("a Jev seat's strategy can be changed mid-game", switchSeat.status === 200 && switchSeat.json.game.players.b.strategyId === "attacking");
check("the weight override is reflected in the snapshot", switchSeat.json?.game?.players?.b?.weights?.kingPressure === 0.9);

// SSE: the first frame must be a full state snapshot.
const sse = await fetch(`${BASE}/api/games/${game.id}/events`, { headers: { Accept: "text/event-stream" } });
check("GET /events opens an event stream", sse.status === 200 && /text\/event-stream/.test(sse.headers.get("content-type") ?? ""));
if (sse.status === 200 && sse.body) {
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 5000;
  let frame = null;
  while (Date.now() < deadline && !frame) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const match = buffer.match(/event: (\w+)\ndata: (.+)\n\n/);
    if (match) frame = { event: match[1], data: JSON.parse(match[2]) };
  }
  check("the stream sends a state frame on connect", frame?.event === "state", `got ${frame?.event}`);
  check("the state frame contains a full game snapshot", Boolean(frame?.data?.game?.id));
  check("the state frame carries serverTime", typeof frame?.data?.serverTime === "number");
  await reader.cancel().catch(() => {});
}

const draw = await api(`/api/games/${game.id}/draw`, { method: "POST", body: { action: "offer", color: "w" } });
check("a draw offer to a Jev seat is answered immediately", draw.status === 200 && typeof draw.json?.result?.accepted === "boolean", JSON.stringify(draw.json?.result));
const drawDecided = draw.json?.result?.accepted === true;
check("an accepted draw ends the game as drawn", !drawDecided || draw.json?.game?.status?.result === "1/2-1/2", JSON.stringify(draw.json?.game?.status));

// Resignation gets its own game: the draw above may already have ended this one.
const resignGame = await api("/api/games", {
  method: "POST",
  body: { mode: "human-vs-jev", humanColor: "w", players: { b: { strategyId: "code-only" } } },
});
currentGameId = resignGame.json.game.id;
const resign = await api(`/api/games/${resignGame.json.game.id}/resign`, { method: "POST", body: { color: "w" } });
check("resigning ends the game", resign.status === 200 && resign.json.game.status.result === "0-1", JSON.stringify(resign.json?.game?.status));
check("the resignation reason is reported", resign.json?.game?.status?.reason === "resignation");
const afterOver = await api(`/api/games/${resignGame.json.game.id}/moves`, { method: "POST", body: { from: "d2", to: "d4" } });
check("no moves are accepted after the game ends", afterOver.status === 409 && afterOver.json?.error?.code === "game-over");

// A human who took Black must be answered by Jev on move one.
const asBlack = await api("/api/games", {
  method: "POST",
  body: { mode: "human-vs-jev", humanColor: "b", players: { w: { strategyId: "code-only" } } },
});
currentGameId = asBlack.json.game.id;
const opened = await waitFor((state) => state.history.length >= 1, { timeoutMs: 20_000, intervalMs: 200 });
check("Jev opens when the human takes Black", opened?.history?.length >= 1, `history ${opened?.history?.length}`);
check("the opening move was played by the Jev seat", opened?.history?.[0]?.by === "jev");
check("the human can then reply as Black", (await api(`/api/games/${asBlack.json.game.id}/moves`, { method: "POST", body: { from: "e7", to: "e5" } })).status === 200);

// --- a Jev-vs-Jev game (mock or real) --------------------------------------

const battle = await api("/api/games", {
  method: "POST",
  body: { mode: "jev-vs-jev", players: { w: { strategyId: "balanced" }, b: { strategyId: "positional" } } },
});
check("POST /api/games creates a Jev vs Jev game", battle.status === 201, `status ${battle.status}`);
currentGameId = battle.json.game.id;

const played = await waitFor((state) => state.history.length >= 4, { timeoutMs: 45_000, intervalMs: 250 });
check("both Jev seats move by themselves", played?.history?.length >= 4, `history ${played?.history?.length}`);
check("every Jev move carries a record", (played?.history ?? []).every((move) => move.by === "jev" && move.jev));
const records = (played?.history ?? []).map((move) => move.jev);
check("each record lists at least three candidates", records.every((record) => (record?.candidates ?? []).length >= 3));
check("each record used exactly one request", records.every((record) => record?.requests === 1));
check("usage is reported per move", records.every((record) => record?.usage?.input_tokens > 0));
check(
  "the two seats ran different strategies",
  (played?.history ?? []).some((move) => move.jev.strategyId === "balanced") && (played?.history ?? []).some((move) => move.jev.strategyId === "positional"),
);
if (health.json?.mock) {
  check("mock results are labelled as mock in the record", records.every((record) => record?.mock === true));
}
check("notes explain the decision", records.every((record) => Array.isArray(record?.notes) && record.notes.length > 0));

const paused = await api(`/api/games/${currentGameId}/autoplay`, { method: "POST", body: { running: false } });
check("a Jev vs Jev game can be paused", paused.status === 200 && paused.json.game.autoplay === false);

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Server, wire format and the AI turn loop all behave as the contract describes.");
}
