# JevChess

Chess played by **Jev**, TypeSafe's System One model — in a browser, with the pieces
moving, a configurable strategy on each seat, and every judgement Jev made shown next to
the move it produced.

- **Human vs Jev** — you take either colour, Jev takes the other.
- **Jev vs Jev** — two strategies play each other, move by move, with pause and step.
- **Configurable strategy per seat** — 8 presets (one labelled *best*) plus sliders that
  change how the code's search and Jev's judgements are blended.
- **Zero dependencies, no build step** — a plain Node server and plain browser modules.

```
node --version    # 20 or newer
npm start         # → http://127.0.0.1:8787
```

Without an API key the server plays **mock Jev** — deterministic, clearly labelled in the
UI, and useless as chess. Everything else (rules, board, clocks, animations, panels) is
real, so you can try the whole app before spending anything.

To play with the real model, put your key in `.env` (see `.env.example`) and restart:

```
TYPESAFE_API_KEY=...        # https://console.typesafe.ai/keys
```

The key is read server-side only. It is never sent to the browser, never put in a URL and
never logged. `.env` is gitignored.

---

## The interesting problem: Jev is not a chatbot

Jev does not write text and does not reason out loud. You send it a `state` and a map of
typed questions, and it returns typed answers your code branches on:

| Question | Returns |
| --- | --- |
| `choice` | the chosen option, a probability for every option, a confidence |
| `score` | a position on ordered levels, plus probabilities |
| `noul` | yes/no as a probability in 0–1 |

It also cannot search, cannot count material across a board, and will occasionally answer
about a move that does not exist. So "Jev plays chess" cannot mean "prompt a model and
parse a move out of the reply". The design is the one the TypeSafe docs recommend:
**code owns everything checkable, Jev owns the judgement**, and the two are combined with
weights a human can see and edit.

Concretely, for every move:

1. **Code** enumerates the legal moves and runs a shallow search (alpha-beta with
   quiescence, piece-square tables) to rank them. Nothing illegal can ever be played.
2. **Code** builds the state Jev sees: the position as a diagram, the move history, and for
   each candidate a plain-language description, the machine-checked facts (capture, check,
   promotion, castle, how many replies the opponent has) and **the diagram of the position
   after the move** — Jev cannot visualise a board it was not shown.
3. **Jev** judges the shortlist: which candidate is best (one `choice` question), how good,
   how safe, how active, how much king pressure, how safe its own king, pawn structure and
   endgame technique (one atomic `score` question per candidate per dimension), plus its
   read of the position (standing / phase / plan).
4. **Code** blends the search score and Jev's scores with the strategy's weights, and plays
   the winner. The whole decision is written into the move record the UI renders.

Everything Jev is asked lives in **one file**: [`src/jev/questions.js`](src/jev/questions.js).
Every weight and threshold lives in **one file**: [`src/strategies.js`](src/strategies.js).
Those two are the files to read and to edit.

### What Jev is *not* shown (deliberately)

| Withheld | Why | Switch |
| --- | --- | --- |
| The search's ranking or centipawn scores | Jev would anchor on them and its own read of the position would stop carrying information | `includeSearchHints` |
| The list of captures available to the opponent | Makes the `safety` dimension nearly mechanical and duplicates the search | `exposeCaptureEvidence` |

Both are off by default and exist so `tools/experiment.mjs` can measure what they change —
the honest way to decide whether the defaults are right.

---

## The four pipelines

`src/jev/pipelines.js`. A strategy picks one.

| Pipeline | How the move is decided | Jev requests / move |
| --- | --- | --- |
| **Shortlist + composite** (`balanced`, *best*) | Search ranks all legal moves; the top N become candidates; Jev scores them; weights decide | 1 |
| **Pure Jev choice** | Every legal move goes to Jev as one choice question; its top pick plays | 1 |
| **Jev nominates, Jev verifies** | Jev picks, then audits its own pick with yes/no questions; a veto excludes the move and Jev is asked again | 2+ |
| **Code only** | The search plays; Jev is never asked. Control opponent | 0 |

No matter which pipeline runs, an illegal, invented or unreadable answer degrades to
something legal and the fallback is stated in the move record (`notes` / `errors`). A game
cannot be lost to a bad model answer.

One Jev call per move carries **all** questions — Jev evaluates them in parallel and in
isolation, so 40+ questions cost roughly one round trip.

---

## Strategies

`balanced` is the only preset marked **best**: full shortlist pipeline, five dimensions,
meaningful search weight.

| Preset | Pipeline | Character |
| --- | --- | --- |
| **Balanced (best)** | shortlist + composite | Default for both seats |
| Tactical (hard to beat) | shortlist + composite | 4-ply search, 60% of the weight on the search, Jev asked only quality + safety |
| Positional | shortlist + composite | Jev judges activity, pawn structure, own king safety |
| Attacking | shortlist + composite | Jev's king-pressure score dominates |
| Endgame technician | shortlist + composite | Jev judges technical endgame progress |
| Pure Jev (no code filter) | pure choice | Most literally "Jev plays chess", and the weakest |
| Jev nominates, Jev verifies | nominate + audit | Two or more calls per move; Jev can veto itself |
| Code only (baseline) | search only | Measures how much Jev actually adds |

The UI sliders move the weights: `search`, `choice`, `quality`, `safety`, `activity`,
`kingPressure`, `kingSafety`, `pawnStructure`, `endgameTechnique`. The composite is a
weighted average over whichever signals exist, so a slider set to 0 really removes that
signal. The panel always shows the weights that were in force and the per-candidate
breakdown.

---

## What the interface does

Board on the left, Jev's reasoning on the right.

- Animated piece movement (a reused `<g>` per piece, so pieces slide rather than the board
  re-rendering), drag-and-drop with legal-move dots, click-click moves, promotion picker.
- Highlights: last move, check, selection; toggleable threat arrows computed from the legal
  moves; a Jev/search evaluation bar.
- **Jev judgment panel**: the chosen move, every candidate with its search rank, Jev's
  choice probability, each dimension score as a bar, the composite, and code-assembled tags
  ("wins a knight", "safe", "attacks the king"). Clicking a candidate previews it.
- Move list with history preview, FEN load/copy, PGN copy/download, undo, flip, resign,
  draw offers (a Jev opponent answers a draw offer itself, with the probability it used).
- Clocks with increment, interpolated between server updates; pause/step for Jev vs Jev;
  an "AI thinking…" indicator.

---

## Tests

```
npm test              # everything below in one run
npm run test:engine   # 189 checks: perft to depth 5, castling, en passant, SAN, draws
npm run test:ui       # 59 checks: board geometry, clocks, history preview, PGN
npm run test:strategy # 45 checks: pipelines, fallbacks, veto loop, composite, game loop
npm run bench         # how long the code half of a move takes
npm run smoke         # drives a running server over HTTP + SSE (62 checks)
```

What each protects:

- **Engine** — the rules are correct, proved against the standard perft node counts
  (startpos to depth 5 = 4,865,609; Kiwipete to depth 4 = 4,085,603; four more positions).
  If the engine is wrong, nothing above it means anything.
- **Strategy** — Jev is *mocked*: legal moves only, contract-shaped records, invented move
  names falling back to real options, a silent Jev deferring to the search, the veto loop
  excluding what it vetoed, the composite arithmetic, clocks flagging, undo pairing.
- **UI logic** — the DOM-free half of the front end.
- **Smoke** — the real wire format: REST snapshots, a human move, an AI reply arriving on
  its own, SSE frames, error codes, undo, strategy switching, draw and resignation.

## Does Jev actually understand chess?

That is an empirical question, and the app is built so it can be answered rather than
assumed. `tools/experiment.mjs` labels positions with facts the rules engine proves, then
measures Jev's judgement against those labels:

```
npm run experiment          # needs TYPESAFE_API_KEY
node tools/experiment.mjs --only prompt-shape
```

1. **Mate in one** — does Jev choose the mating move?
2. **Winning material** — does it find the ≥200cp-best move?
3. **Blunder detection** — given a candidate that hangs a piece, does Jev score its safety
   lower than the best move's?
4. **Agreement** — how often its top choice matches a 3-ply search, and the Spearman
   correlation between its quality scores and search centipawns.
5. **Prompt shape** — the same positions with/without board diagrams and with/without the
   opponent's captures. This is what should decide the two switches above.

It writes `experiments/results-<timestamp>.json`. With no key it runs against the mock so
you can see the mechanics — those numbers say nothing about Jev.

**Not yet run against the real model**, because no key was available while building it.
Expect the first real run to suggest editing questions and weights; that is the intended
workflow, not a failure. Jev's competence at chess is the main open question in this
project, and nothing here pretends otherwise.

## Cost and latency

Per move, one request of roughly 3–6k input tokens (a 12-candidate shortlist, ~55
questions). At Jev's $0.042 per million input tokens with free output that is about
**$0.0003 per move** — a few cents per thousand moves. Limits: 64k tokens per request,
32k for the state plus the longest question.

Latency is dominated by the code search, which is capped at 1.4 s per move (`balanced`), plus
one model round trip. The search deepens iteratively and returns the deepest completed
iteration, so a busy position costs a 2-ply look rather than an unbounded 3-ply one. The
evaluation bar uses a separate 200 ms budget so the human's own moves feel immediate.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | – | Bearer token. Absent ⇒ mock Jev |
| `TYPESAFE_MODEL` | `jev-latest` | Model id or alias; pin `jev-1.13.0` to freeze behaviour |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Listen address |
| `JEV_MOCK` | – | `1` forces the mock even with a key (offline UI work) |

## Layout

```
CONTRACT.md              the frozen HTTP/SSE + state contract the UI is built against
src/server.js            http + SSE + static files, .env loading, key stays here
src/game.js              rules, players, clocks, move records, the AI turn loop
src/strategies.js        presets, sliders, the search time budget   ← edit weights here
src/engine/chess.js      0x88 rules engine (perft-verified)
src/engine/search.js     alpha-beta + quiescence + evaluation, iterative deepening
src/jev/client.js        TypeSafe client: retries, backoff, error mapping, mock
src/jev/state.js         what Jev sees (and the two deliberate omissions)
src/jev/questions.js     every question and threshold               ← edit wording here
src/jev/pipelines.js     the four ways a move gets chosen
public/                  the board and panels (no framework, no build step)
tools/experiment.mjs     measures Jev's chess judgement
tools/smoke.mjs          drives a running server end to end
```

## Honest limitations

- **The code search is a shortlist generator, not a strong engine.** Material, piece-square
  tables, quiescence, 2–5 ply within a time budget. It keeps Jev from hanging pieces; it is
  not playing strength on its own.
- **Mock Jev is not chess.** With no key, moves are pseudo-random but deterministic, and the
  UI says so. Any strategy comparison run in mock mode is meaningless.
- **Rendering is unverified by pixels.** Everything visual was checked by unit tests, a
  DOM-stub load, a fake-server integration pass, syntax checks and static review — but no
  browser was available in the build environment, so nobody has looked at the board yet.
  Glyph metrics inside the SVG cells and the right-hand column's width at 1280×800 are the
  two things most worth your eye.
- **Draw offers to a Jev opponent** are decided by a single yes/no question about the
  current position, not by anything resembling a real evaluation.
- Only a single Jev call per move is used in the composite pipeline; the audit pipeline adds
  a second. Nothing here explores cost/quality tradeoffs across many parallel requests.

## Ideas that would make it stronger

- Run the experiment suite against real Jev and retune the questions and weights.
- Add a "Jev impact" scoreboard: play `balanced` vs `code-only` over many games and count
  how often Jev's judgement beat the search's own top move.
- Feed the audit verdict back in: use `audit_*` answers as extra signals in the composite.
- Per-question confidence gates, so a low-confidence dimension is dropped instead of
  weighted equally.
