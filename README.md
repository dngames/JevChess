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

On Windows there is a better option than a plaintext file — **Windows secure storage**,
which encrypts the key with DPAPI for your user only, outside the repository:

```
npm run key:set        # hidden prompt: paste the key, press Enter (nothing is echoed)
npm run key:status     # confirms a key is stored, never prints the key itself
npm run key:clear
```

If the terminal is not interactive — a script, a CI job, a sandbox — there are two other ways
in that use the same tested storage path:

```
npm run key:set -- --from-env TYPESAFE_API_KEY     # take it from an environment variable
Get-Content key.txt | npm run key:set              # or pipe it in
```

Decryptable only by the same Windows user on the same machine, so a copy of that blob is
useless elsewhere, unlike a copy of `.env`. `TYPESAFE_API_KEY` in the environment or `.env`
still takes precedence when present, and any failure in this path degrades to mock play
instead of stopping the server.

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

`npm test` runs the four fast suites (~70 s). Three are separate on purpose: `test:soak` plays
whole games and takes about two minutes, `check:browser` needs Chrome, and `test:key` needs
PowerShell (its prompt half runs anywhere, and the storage half reports SKIP where child
processes cannot be spawned).

```
npm test              # everything below in one run
npm run test:engine   # 189 checks: perft to depth 5, castling, en passant, SAN, draws
npm run test:ui       # 59 checks: board geometry, clocks, history preview, PGN
npm run test:strategy # 45 checks: pipelines, fallbacks, veto loop, composite, game loop
npm run test:payload  # 23 checks: the HTTP request and every payload, against the API schema
npm run test:soak     # 9 checks, ~2 min: whole games played to a finish and replayed
npm run test:key      # 16 checks: the key prompt and the Windows secure-storage round trip
npm run bench         # how long the code half of a move takes
npm run smoke         # drives a running server over HTTP + SSE (62 checks)
npm run real-check    # asks a live server for one real Jev move and inspects the record
npm run check:browser # renders the app in headless Chrome and plays real moves
```

What each protects:

- **Engine** — the rules are correct, proved against the standard perft node counts
  (startpos to depth 5 = 4,865,609; Kiwipete to depth 4 = 4,085,603; four more positions).
  If the engine is wrong, nothing above it means anything.
- **Strategy** — Jev is *mocked*: legal moves only, contract-shaped records, invented move
  names falling back to real options, a silent Jev deferring to the search, the veto loop
  excluding what it vetoed, the composite arithmetic, clocks flagging, undo pairing.
- **UI logic** — the DOM-free half of the front end.
- **Payload** — the half of the integration a mocked Jev cannot check: that the request goes
  to `POST https://api.typesafe.ai/v1/systemone` with a bearer token, that the body is
  exactly `state`/`model`/`questions`, that every question matches the documented schema
  (option maps for `choice`, 2–10 distinct levels for `score`, `true`/`false` criteria for
  `noul`), that every `cand_*` question names a candidate that exists in the state it rides
  with, that the payload survives JSON exactly, and that it fits the 64k/32k limits. It also
  asserts that the API key can never appear in an error message, and that 429/5xx retry while
  422 does not. This is what makes the first call with a real key likely to work first time.
- **Smoke** — the real wire format: REST snapshots, a human move, an AI reply arriving on
  its own, SSE frames, error codes, undo, strategy switching, draw and resignation.
- **Key storage** — the hidden prompt (a pasted key arriving as one chunk, backspace, Ctrl+C,
  a non-terminal stream being refused rather than hanging) and the DPAPI round trip
  store → read → clear, plus the CLI's masked `get`, `status` and a failed `set` leaving no
  blob behind. It copies an existing key aside and restores it, so it is safe to run with a
  real key stored. This suite exists because the first `key:set` shipped broken — it asked
  PowerShell's `Read-Host` while spawning PowerShell `-NonInteractive` — and the lesson is
  that the documented command needs a test, not just the function underneath it.
- **Soak** — whole games, which is where the long tail lives. Against engine/mock seats with a
  deliberately tiny search budget (the point is the loop, not the strength), it plays games to
  a real result and asserts that every game **replays move for move** from its own record. It
  has exercised games up to 289 plies, castling by both sides, promotion (including
  underpromotion), mate, threefold repetition, insufficient material, flag falls and undo
  mid-game — and it found the bug where a requested per-player search budget was silently
  ignored, so "fast game" requests ran at the preset's 1.4 s per move.

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

### Does Jev's judgement add anything?

The other half of the question, and a different instrument. `tools/selfplay.mjs` plays whole
games between two strategies unattended and measures whether letting Jev judge a move beats
letting the search decide:

```
npm run selfplay                                    # balanced vs code-only, 2 games
npm run selfplay -- --games=6 --a=balanced --b=pure-jev --budget=300
npm run selfplay -- --mock                          # mechanics only
```

The load-bearing metric is the **impact**: every time a seat's composite pick differed from
the search's own top move, both moves are re-evaluated by a *deeper, independent* reference
search (depth 4, 1.2 s by default). Better scores count as a win for Jev's judgement, worse
as a loss, within ±20cp as indistinguishable. Code computes that verdict — no model grades
itself. The run also reports the match score by colour, game lengths, termination reasons, and
a fallback count that must be zero (a move needing rescue means something is broken).

Costs, measured: about 30 s per game at a 150 ms seat budget, and ~$0.01 of Jev tokens for a
two-game run at the defaults. With the mock, Jev's answers are pseudo-random, so a *negative*
impact is the correct and expected result — it is how you know the metric discriminates rather
than flatters. Real numbers need a key.

### What the real measurements say

Both instruments have now been run against the live API (`jev-1.13.0`, via a key in Windows
secure storage). This is the honest state of Jev's chess:

**As a judge of a concrete question, Jev is excellent.** Every one of these is a fact the
rules engine proved before Jev was asked:

| Experiment | Result |
| --- | --- |
| Mate in one (4 positions, both colours) | **4/4** — found every mating move |
| Win ≥200cp of material (3 positions) | **3/3** — Kxe2, Rxd8+, Rxd5 |
| Score a blunder's safety lower than the best move's (9 positions) | **9/9** — e.g. 0.19 vs 0.53 |
| Top-1 agreement with a 3-ply search (18 positions) | 12/18 (67%) |
| Correlation between its quality scores and search centipawns | +0.35 |

**As the thing that overrides a chess engine, it is not yet an improvement.** In real games
(`npm run selfplay`, `balanced` vs the `code-only` baseline at a 300 ms budget), Jev changed
the move on 29% of plies, and when those changes were re-judged by a deeper search they
averaged **−50 cp** (0 better, 12 worse, 10 indistinguishable). Leaning harder on the search
(`--weights="search=0.6,choice=0.1,quality=0.15,safety=0.1,activity=0.05"`) roughly halved
that cost to **−24 cp**, with 58% of deviations indistinguishable.

Three caveats, because this measurement has a real bias in it:

1. **The yardstick is not independent.** Deviations are scored by the same material-and-table
   evaluator that produced the search's move, so it structurally favours the search. It
   measures agreement with a deeper search, not better chess. A judge that prefers a sound
   long-term plan to a shallow material grab would look bad here and be right.
2. **The match result says nothing yet.** Two games per configuration (1–1, then 0–2) is far
   too few; `--games=20` is the honest way to settle it, and it is a few cents.
3. **Two of the nine "chose the blunder" cases were labelling artifacts** — positions where
   White is already winning by a queen, where the worst move by search score is not a blunder
   at all. Jev had nonetheless ranked both as less safe.

What this suggests, and what the tooling now makes testable: Jev is a good *judge* and a
mediocre *overrider*. Its concrete, checkable dimensions (quality, safety) look well calibrated;
its positional ones (activity, king pressure) are where unverifiable deviations come from. The
next experiment is a weight sweep, and possibly asking only quality and safety in sharp
positions.

## Cost and latency

Measured, not guessed — `npm run test:payload` prints this table for a real middlegame
(Jev bills input tokens at $0.042 per million; output is free):

| Strategy | Requests | Questions | Input tokens | Cost / move |
| --- | --- | --- | --- | --- |
| `balanced` (best) | 1 | 64 | 12 347 | $0.00052 |
| `attacking` | 1 | 60 | 12 429 | $0.00052 |
| `endgame` | 1 | 52 | 10 492 | $0.00044 |
| `positional` | 1 | 52 | 9 994 | $0.00042 |
| `tactical` | 1 | 20 | 4 949 | $0.00021 |
| `pure-jev` | 1 | 4 | 3 880 | $0.00016 |
| `jev-verify` | 2 | 8 | 4 433 | $0.00019 |
| `code-only` | 0 | 0 | 0 | $0 |

At the default strategy that is roughly **$0.0005 per move, about 1 900 moves per dollar**.
Against the live API the first real move cost **$0.0006** and reported **14 283 input tokens** —
so the estimate above is about 14% low, because it counts characters divided by four rather
than real tokens. Latency measured on that move: **2.1 s inside Jev** (1.35k output tokens are
free), plus ~1.5 s of code search, i.e. a few seconds per move in total.

The interesting part is *where* the tokens go: only ~2 000 of the 12 300 are the position
itself; the rest is question text, because every candidate gets one Score question per
dimension. So the cost knob is candidates × dimensions — which is exactly why `tactical`
(8 candidates, 2 dimensions) is 2.5× cheaper than `balanced` (12 × 5).

Latency is dominated by the code search, capped at 1.4 s per move, plus one model round
trip. The search deepens iteratively and returns the deepest completed iteration, so a busy
position costs a 2-ply look rather than an unbounded 3-ply one. The evaluation bar uses a
separate 200 ms budget so the human's own moves feel immediate. Documented limits: 64k
tokens per request, 32k for the state plus the longest question — the widest strategy above
peaks at ~2 300 tokens for state + longest question, so there is a lot of headroom for more
questions.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | – | Bearer token. Absent ⇒ mock Jev |
| `TYPESAFE_MODEL` | `jev-latest` | Model id or alias; pin `jev-1.13.0` to freeze behaviour |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Listen address |
| `JEV_MOCK` | – | `1` forces the mock even with a key (offline UI work) |

The key has two homes, checked in this order:

1. `TYPESAFE_API_KEY` in the environment or `.env` (a shell variable wins).
2. **Windows secure storage** — `npm run key:set` encrypts it with DPAPI for your Windows
   user into `%LOCALAPPDATA%\JevChess\jev-key.dpapi`, outside the repository. A stolen file
   is useless. `npm run key:status` and `npm run key:clear` manage it.

## Layout

```
CONTRACT.md              the frozen HTTP/SSE + state contract the UI is built against
src/server.js            http + SSE + static files, .env loading, key stays here
src/game.js              rules, players, clocks, move records, the AI turn loop
src/strategies.js        presets, sliders, the search time budget   ← edit weights here
src/engine/chess.js      0x88 rules engine (perft-verified; see src/engine/README.md)
src/engine/search.js     alpha-beta + quiescence + evaluation, iterative deepening
src/jev/client.js        TypeSafe client: retries, backoff, error mapping, mock
src/jev/state.js         what Jev sees (and the two deliberate omissions)
src/jev/questions.js     every question and threshold               ← edit wording here
src/jev/pipelines.js     the four ways a move gets chosen
public/                  the board and panels (no framework, no build step)
screenshots/             evidence from the last browser check (committed)
tools/experiment.mjs     measures Jev's chess judgement against engine-proved labels
tools/selfplay.mjs       match runner + "does Jev's judgement add anything?" metric
tools/smoke.mjs          drives a running server end to end
tools/browser-check.mjs  renders the app in headless Chrome and plays real moves
tools/win-key.mjs        store / inspect / clear the API key in Windows secure storage
tools/real-check.mjs     "is this server really talking to Jev?" against a live server
```

## Honest limitations

- **The code search is a shortlist generator, not a strong engine.** Material, piece-square
  tables, quiescence, 2–5 ply within a time budget. It keeps Jev from hanging pieces; it is
  not playing strength on its own — and it is also the yardstick the match runner uses, which
  is the bias called out above.
- **Jev's judgement is measurably good and measurably costly.** It finds every mate in one and
  every clear material win, and ranks blunders as less safe 9 times out of 9 — but its
  deviations from the search average −24 to −50 cp by the search's own evaluation. The
  headline numbers are in the section above, including why the yardstick is not neutral.
- **Mock Jev is not chess.** With no key, moves are pseudo-random but deterministic, and the
  UI says so. Any strategy comparison run in mock mode is meaningless.
- **The board has been looked at, but only headlessly.** `npm run check:browser` renders the
  app in headless Chrome, plays a real drag-and-drop move, and writes the committed
  `screenshots/`. That confirms geometry, glyphs, animation wiring, the dialog and the
  panels — it is not the same as a person using it, and the browser check itself needs
  Chrome plus wider permissions than a sandboxed session allows. Your eye is still the
  final word on whether it *feels* right.
- **Draw offers to a Jev opponent** are decided by a single yes/no question about the
  current position, not by anything resembling a real evaluation.
- Only a single Jev call per move is used in the composite pipeline; the audit pipeline adds
  a second. Nothing here explores cost/quality tradeoffs across many parallel requests.

## Ideas that would make it stronger

- Settle the weight question with a sweep: `npm run selfplay -- --weights="search=0.6,..."`.
  The measurement above says `balanced` should probably lean harder on the search, and the
  flag now exists to test it properly.
- Play a real match (`npm run selfplay -- --games=20`, a few cents). Two games per
  configuration is not a match, and the match is the only yardstick here that is not the
  search grading itself.
- Harden the prompt-shape experiment with positional positions. On the current tactical set
  all four state shapes scored 100%, so it cannot yet say whether the board diagrams earn
  their ~1.3k tokens.
- Feed the audit verdict back in: use `audit_*` answers as extra signals in the composite.
- Per-question confidence gates, so a low-confidence dimension is dropped instead of
  weighted equally.
