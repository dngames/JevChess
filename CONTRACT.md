# JevChess — interface contract (frozen)

This file is the contract between the server/strategy layer and the browser UI.
Both sides are built against it. **Do not change a field name here without changing
both sides.** The server is authoritative for all game rules, clocks and AI moves.

Zero dependencies, no build step, no CDN: plain Node (ESM) server, plain browser ESM
modules, hand-written SVG/CSS. The API key never leaves the server.

## Layout

```
package.json          {"type":"module"}, scripts.start, scripts.test
.env                  (gitignored) TYPESAFE_API_KEY=...
.env.example
public/index.html     the app shell
public/style.css
public/js/*.js        browser ES modules, relative imports with .js extensions
src/engine/chess.js   rules engine (perft-verified; API and its two traps in src/engine/README.md)
src/engine/search.js  shallow negamax + static eval + threat detection
src/jev/client.js     TypeSafe HTTP client (retry/backoff, mock provider)
src/jev/state.js      builds the `state` object sent to Jev
src/jev/questions.js  ALL question wording + strategy weights (the file a human reviews)
src/jev/pipelines.js  the three move-selection pipelines
src/strategies.js     preset strategies + slider schema
src/game.js           Game: rules + players + clocks + move records + event emitter
src/server.js         http server: REST + SSE + static files + .env
```

## Server

Default `http://127.0.0.1:8787` (override with `PORT`). Binds 127.0.0.1 unless `HOST` is set.

### REST

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api/health` | – | `{ ok, model, hasApiKey, mock, version, serverTime }` |
| GET | `/api/strategies` | – | `{ presets: Strategy[], sliders: Slider[], pipelines: {id,name,description}[] }` |
| POST | `/api/games` | `NewGameRequest` | `{ game: GameState }` |
| GET | `/api/games/:id` | – | `{ game: GameState }` |
| POST | `/api/games/:id/moves` | `{ from, to, promotion? }` or `{ san }` | `{ game: GameState }` |
| POST | `/api/games/:id/undo` | – | `{ game: GameState }` |
| POST | `/api/games/:id/resign` | `{ color? }` | `{ game: GameState }` |
| POST | `/api/games/:id/draw` | `{ action: "offer" \| "accept" \| "decline" }` | `{ game: GameState }` |
| POST | `/api/games/:id/autoplay` | `{ running: boolean }` | `{ game: GameState }` |
| POST | `/api/games/:id/step` | – | `{ game: GameState }` (ask the side to move to move once) |
| POST | `/api/games/:id/players` | `{ w?: PlayerConfig, b?: PlayerConfig }` | `{ game: GameState }` (change a strategy mid-game) |
| GET | `/api/games/:id/events` | – | SSE stream, see below |

Errors: `{ error: { code, message } }` with codes `bad-request` (400), `not-found` (404),
`illegal-move` (409), `not-your-turn` (409), `game-over` (409), `jev-unavailable` (503),
`jev-error` (502). The UI shows `error.message` verbatim — make messages human-readable.

### SSE (`/api/games/:id/events`)

`text/event-stream`. A comment heartbeat (`: ping`) every 15 s. Every payload is
`{ serverTime: number, ... }` and named events are:

| event | payload | meaning |
| --- | --- | --- |
| `state` | `{ game: GameState }` | full authoritative snapshot; sent once on connect and after every change |
| `ai-thinking` | `{ side, playerName, strategyName, startedAt }` | an AI turn started |
| `ai-result` | `{ side, move: MoveRecord, elapsedMs }` | the AI decided (also appears in `game.history`) |
| `notice` | `{ level: "info"\|"warn"\|"error", message }` | transient toast for the UI |
| `game-over` | `{ result, reason }` | end of game |

The UI must tolerate receiving only `state` events (it is the source of truth) and must
render correctly from a bare `GameState` snapshot with no prior events.

## Shapes

### GameState

```jsonc
{
  "id": "g_ab12",
  "createdAt": 1730000000000,
  "mode": "human-vs-jev" | "jev-vs-jev",
  "humanColor": "w" | "b" | null,
  "fen": "rnbq...",
  "turn": "w" | "b",
  "moveNumber": 1,
  "board": [ Piece | null, ... ],        // exactly 64, rank 8 first, left to right = a..h
  "legalMoves": [ LegalMove, ... ],      // for the side to move; [] when the game is over
  "lastMove": { "from": "e2", "to": "e4", "san": "e4" } | null,
  "check": { "inCheck": true, "square": "e1" } | { "inCheck": false, "square": null },
  "status": { "over": false, "result": null, "reason": null },
  "history": [ MoveRecord, ... ],
  "players": { "w": PlayerState, "b": PlayerState },
  "clocks": {
    "w": 300000, "b": 300000, "initialMs": 300000, "incrementMs": 0,
    "running": "w" | "b" | null, "updatedAt": 1730000000000
  } | null,
  "ai": { "thinking": true, "side": "w" | "b" | null, "startedAt": 1730000000000, "strategyName": "Balanced" },
  "autoplay": true,                      // jev-vs-jev: is the loop running
  "drawOffer": "w" | "b" | null,         // side that has a pending draw offer
  "evalBar": { "cp": 34, "whiteWinProb": 0.55, "source": "search" | "jev", "label": "+0.34" },
  "jev": { "hasApiKey": true, "mock": false, "model": "jev-latest", "lastError": null }
}
```

`Piece` = `{ "square": "e4", "type": "p"|"n"|"b"|"r"|"q"|"k", "color": "w"|"b" }`.

`LegalMove` = `{ "from", "to", "san", "promotion": "q"|"r"|"b"|"n"|null, "captured": "p"|...|null, "flags": "nc" }`
(`flags` uses the engine's semantics; the UI only uses `san`, `captured` and `promotion`).

`PlayerState` = `{ "kind": "human"|"jev", "name": "You"|"Balanced"|..., "strategyId": "balanced",
"pipeline": "shortlist-composite"|"pure-choice"|"nominate-verify", "weights": { "search": 0.35, ... } }`

### MoveRecord (one per ply)

```jsonc
{
  "ply": 1, "moveNumber": 1, "color": "w", "san": "Nf3", "from": "g1", "to": "f3",
  "capture": null, "check": false, "mate": false, "promotion": null, "castle": null,
  "fenAfter": "...", "at": 1730000000000, "clockMs": 298400,
  "by": "human" | "jev",
  "jev": JevMove | null            // null for human moves
}
```

### JevMove — what the judgment panel renders

```jsonc
{
  "mock": false,
  "model": "jev-1.13.0",
  "pipeline": "shortlist-composite",
  "strategyId": "balanced", "strategyName": "Balanced (best)",
  "chosenSan": "Nf3", "chosenFrom": "g1", "chosenTo": "f3",
  "chosenRank": 2,                      // 1-based rank of the chosen move in the final composite ordering
  "searchRankOfChosen": 3,              // where it stood before Jev's judgment (shows Jev's impact)
  "candidates": [
    {
      "san": "Nf3", "from": "g1", "to": "f3", "chosen": true,
      "searchCp": 28, "searchRank": 3, "searchScore": 0.62,
      "choiceProb": 0.31,               // Jev's probability for this move, 0..1 (null if not asked)
      "dims": { "quality": 0.75, "safety": 0.80, "activity": 0.60, "kingPressure": 0.25 },  // normalized 0..1
      "composite": 0.71,                // weighted total; see "weights"
      "tags": ["develops", "keeps tension"]     // code-assembled from facts + Jev's answers
    }
  ],
  "weights": { "search": 0.35, "choice": 0.15, "quality": 0.2, "safety": 0.15, "activity": 0.1, "kingPressure": 0.05 },
  "notes": ["Jev's pick differed from the search's top move (Bb5 → Nf3)."],  // code-assembled sentences
  "audit": [ { "question": "Does this move hang a piece?", "noul": 0.12, "veto": false } ],   // nominate-verify only
  "vetoed": ["Qh5"],                    // moves Jev's audit rejected, for the panel
  "usage": { "input_tokens": 4210, "output_tokens": 180 },
  "requests": 1, "elapsedMs": 1350,
  "questionIds": ["cand_0_quality", "cand_0_safety", "..."],
  "errors": []                          // non-fatal per-question problems, e.g. a candidate Jev never scored
}
```

### NewGameRequest

```jsonc
{
  "mode": "human-vs-jev" | "jev-vs-jev",
  "humanColor": "w",                    // human-vs-jev only
  "fen": "optional start FEN",
  "timeControl": { "initialMs": 300000, "incrementMs": 2000 } | null,
  "players": { "w": PlayerConfig, "b": PlayerConfig }
}
```

`PlayerConfig` = `{ "strategyId": "balanced", "weights": { "search": 0.35, ... } }`
(weights optional; omitted keys fall back to the preset's values).

### Strategy / Slider (from `/api/strategies`)

```jsonc
// presets[]
{
  "id": "balanced", "name": "Balanced (best)", "description": "…",
  "pipeline": "shortlist-composite",
  "candidateLimit": 12, "searchDepth": 3, "temperature": 0.15,
  "dims": ["quality", "safety", "activity", "kingPressure"],
  "weights": { "search": 0.35, "choice": 0.15, "quality": 0.2, "safety": 0.15, "activity": 0.1, "kingPressure": 0.05 },
  "best": true
}
// sliders[]
{ "key": "search", "label": "Code search (material/tactics)", "min": 0, "max": 1, "step": 0.05,
  "default": 0.35, "help": "Weight of the server's shallow search score. High = safer, less Jev." }
```

## UI requirements

Single page at `/`. No frameworks, no CDN, no build step, works in current Chrome.
Layout: board centred; right column = Jev judgment panel + move list; top bar = players,
clocks, status, controls (New game, Undo, Flip, Resign, Draw, Pause/Resume, Step).

1. **Board**: 8×8 SVG, coordinates on the edges, light/dark squares, pieces as Unicode
   chess glyphs using the *solid* glyphs (♚♛♜♝♞♟) coloured via CSS so white pieces are
   white with a dark outline — never rely on the outline glyphs (♔♕♖♗♘♙) being available.
2. **Moving pieces**: after a state update, animate the piece from its previous square to
   its new square (transform transition, ~220 ms, ease-out), knights/castling included;
   captures fade out; promotions swap to the new piece. Never animate the whole board.
3. **Dragging**: drag your own pieces with pointer events; dragging shows legal target dots
   (`.dot` for quiet moves, a ring for captures); releasing on an illegal square snaps back.
   The same move may be played by clicking origin then destination. Promotion opens a small
   picker for q/r/b/n. Input is ignored unless `mode` is `human-vs-jev` and `turn === humanColor`.
4. **Highlights**: last move (both squares), check (king square, red glow), selected square,
   hover target, and your legal moves when a piece is picked up.
5. **Threat arrows**: an overlay layer; a toggle shows arrows from every enemy piece to the
   own pieces it attacks, computed client-side from `game.legalMoves` (a piece is attacked if
   some legal enemy move lands on its square).
6. **Eval bar**: vertical bar beside the board driven by `evalBar.whiteWinProb`, plus the
   `label` text; animates smoothly. Say "search" or "Jev" per `source`.
7. **Jev judgment panel**: for the selected/last Jev move show: the chosen move big, the
   candidate table (san, search rank, choice probability bar, per-dimension bars, composite),
   the weights in force, `notes`, `usage`, `elapsedMs`, and the audit list when present.
   Clicking a candidate row previews its move on the board. When `mock` is true, show a clear
   "Mock Jev (no API key)" badge. When `hasApiKey` is false, show a dismissible banner
   explaining how to set `TYPESAFE_API_KEY` in `.env` — the game must still be playable.
8. **Move list**: numbered two-column SAN, click to jump to that position (read-only preview
   of history — do not mutate the game), current ply highlighted, `…` for a missing reply.
9. **Clocks**: per side from `clocks`, interpolated locally from `clocks.updatedAt` and
   `serverTime` (compute a server-client offset from every payload; never trust the local
   clock alone). Format `m:ss`, show tenths under 20 s, flag visually when < 10 s. `MM:SS` +
   increment; disabled when `clocks` is null.
10. **FEN/PGN**: copy current FEN, load a FEN into a new game, download PGN, copy PGN.
11. **Status line**: whose turn, check/checkmate/stalemate/draw reason, an "AI thinking…"
    indicator with the elapsed seconds while `game.ai.thinking`, and the game result.
12. **New game dialog**: mode (1 human vs Jev / Jev vs Jev), human colour, a strategy card +
    slider set per player fetched from `/api/strategies`, time control (none / 1+0 / 3+2 /
    5+0 / 10+0 / custom), optional FEN. Sliders show live numeric values and update the
    preset's weights; changing a preset resets the sliders to that preset's weights.
13. Accessibility/robustness: all controls are real `<button>`/`<input>` elements with
    labels, keyboard: `u` undo, `f` flip, `n` new game. Missing/`null` optional fields must
    never throw. On SSE disconnect, show a discreet "reconnecting…" state (EventSource
    reconnects by itself) and re-fetch `/api/games/:id` on reconnect.

Visual direction: dark, calm, high-contrast; warm off-white and muted olive-grey board
(`#eadfc8` / `#7c8b6a`-ish), soft shadows, rounded panels, system font stack, no external
fonts or images. Must look intentional at 1280×800 and remain usable at 1024 wide and on
mobile widths (board scales to viewport, panels stack below).

---

## Amendments after implementation

Both sides were built from the contract above. These are the deliberate differences found
while building, listed here so the file stays the single source of truth. All are additive:
no field was renamed or removed.

1. **A fourth pipeline exists**: `search-only`, the code-only control opponent (a strategy
   needs a baseline to measure Jev against). `PlayerState.pipeline` may therefore be
   `shortlist-composite` | `pure-choice` | `nominate-verify` | `search-only`. The UI renders
   pipeline names from `GET /api/strategies`, so it needs no change.
2. **`JevMove` gained three fields**: `pipelineName` (human-readable), `assessment` (Jev's
   read of the position: `standing`, `phase`, `plan`, each with `choice`, `probabilities`,
   `confidence`, plus a `labels` block of plain strings), and `search`
   (`{ depth, nodes, bestCp, bestSan, elapsedMs, forDisplayOnly? }`).
3. **`notes` is never empty.** Every decision is explained in prose assembled by code, so
   the panel always has something honest to show. `errors` records recoverable trouble
   (for example an unreachable model); `notes` records what was decided and why.
4. **`GameState` gained `startFen`**, so the UI can tell whether a custom position was used.
5. **PGN and FEN export are client-side**, generated from `history` — there is no PGN
   endpoint. `GET /api/games/:id` returns everything needed for it.
6. **A failed move is never a dead game.** If the model returns nothing usable, the pipeline
   falls back to a legal move (the search's choice where one exists) and says so; the API
   only reports an error when the *request* was bad, not when the model was.
7. **Server-side error codes in practice**: an invalid API key returns HTTP 403 from
   TypeSafe (not 401 as the docs state), which the client maps to `jev-auth`; that is
   reported in `game.jev.lastError` and never blocks play.
8. **`POST /api/games/:id/draw` with `action: "offer"`** returns
   `{ result: { accepted, pending } }` in addition to the snapshot: a Jev opponent answers
   immediately, a human opponent leaves `game.drawOffer` set for the UI to accept or decline.
9. **Static responses carry `Cache-Control: no-store`** (development server: never serve a
   stale bundle) and unknown extension-less paths fall back to the app shell.

