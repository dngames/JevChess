/**
 * "Is the strategy layer really planning?" — a live check against a running server.
 *
 * `real-check.mjs` proves Jev is answering; this proves the *strategist* is, and that its plan
 * survived validation and reached the move. The mock provider makes every offline test pass, so
 * this is the only thing that can tell the difference.
 *
 * Run the server first (with a Gemini key), then: node tools/plan-check.mjs [baseUrl]
 *
 * Costs one Jev request and one or two Gemini requests — well under a cent.
 */

const BASE = (process.argv[2] ?? process.env.JEVCHESS_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    /* not json */
  }
  return { status: response.status, json, text };
}

console.log(`Live strategist check against ${BASE}\n`);

const health = await api("/api/health");
check("the server is reachable", health.status === 200, `status ${health.status}`);
if (health.status !== 200) process.exit(1);

const llm = health.json.llm ?? {};
console.log(`  info  strategist: configured=${llm.configured} model=${llm.model} mock=${llm.mock}`);
check("a strategist is configured", llm.configured === true, llm.configured ? "" : `source: ${llm.source}`);
check("the strategist is not the mock provider", llm.mock === false, llm.mock ? "this would prove nothing" : "");
if (!llm.configured || llm.mock) {
  console.log("\nAdd a real Gemini key first: `npm run key:set -- gemini`, then restart the server.");
  process.exit(1);
}

// --- one planning move ------------------------------------------------------

const created = await api("/api/games", {
  method: "POST",
  body: { mode: "human-vs-jev", humanColor: "w", players: { b: { strategyId: "strategist" } } },
});
check("a game with a planning seat can be created", created.status === 201, `status ${created.status}`);
const gameId = created.json.game.id;
check("the seat reports that it plans", created.json.game.players.b.usesStrategist === true);

const humanMove = await api(`/api/games/${gameId}/moves`, { method: "POST", body: { from: "e2", to: "e4" } });
check("the human move is accepted", humanMove.status === 200, `status ${humanMove.status}`);

const startedAt = Date.now();
let game = null;
while (Date.now() - startedAt < 180_000) {
  const polled = await api(`/api/games/${gameId}`);
  if (polled.json?.game?.history?.length >= 2) {
    game = polled.json.game;
    break;
  }
  await sleep(750);
}
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
check("the planning seat moved within 3 minutes", Boolean(game), game ? `${seconds} s` : "no reply");
if (!game) process.exit(1);

const move = game.history[1];
const record = move.jev;
const plan = record?.llm ?? null;

console.log("\nThe move");
console.log(`  played:      ${move.san} (chosen at search rank ${record.searchRankOfChosen} of ${record.candidates.length} candidates)`);
console.log(`  Jev:         ${record.model}, ${record.usage.input_tokens} in / ${record.usage.output_tokens ?? 0} out, ${record.elapsedMs} ms`);

check("the move carries a plan block", Boolean(plan), plan ? "" : "no record.llm on the move");
if (!plan) {
  console.log("\nThe strategist did not contribute — check the server output for a `[gemini]` line.");
  process.exit(1);
}

console.log("\nThe plan");
console.log(`  plan:        ${plan.plan?.plan} (${plan.plan?.label})`);
console.log(`  targets:     ${plan.plan?.targets?.length ? plan.plan.targets.join(", ") : "none"}`);
console.log(`  risk:        ${plan.plan?.risk}, review in ${plan.plan?.reviewAfterPlies} plies`);
console.log(`  asks Jev:    ${plan.applied?.dims?.join(", ") || "(preset dimensions)"}`);
console.log(`  weight move: ${Object.entries(plan.applied?.weights ?? {}).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(", ") || "none"}`);
console.log(`  if it could: ${plan.plan?.commentary}`);
console.log(`  via:         ${plan.api} API, ${plan.model}, thinking=${plan.thinkingLevel}, ${plan.elapsedMs} ms`);
console.log(`  cost:        ${plan.usage ? `${plan.usage.inputTokens} in / ${plan.usage.outputTokens} out / ${plan.usage.thoughtTokens} thought` : "unknown"}${typeof plan.costUsd === "number" ? ` ≈ $${plan.costUsd.toFixed(5)}` : ""}`);
for (const note of plan.notes ?? []) console.log(`  note:        ${note}`);
for (const problem of plan.problems ?? []) console.log(`  problem:     ${problem}`);
for (const warning of plan.warnings ?? []) console.log(`  warning:     ${warning}`);

check("a plan was actually adopted", Boolean(plan.plan), plan.error ? `error: ${plan.error}` : "");
check("it came from the real model, not the mock", !plan.mock && !/mock/i.test(String(plan.model)), `model=${plan.model}`);
check("it came from Gemini", ["interactions", "generateContent"].includes(plan.api), `api=${plan.api}`);
check("no validation problems", (plan.problems ?? []).length === 0, (plan.problems ?? []).join("; "));
check("the weights in force are normalised", Math.abs(Object.values(record.weights).reduce((a, b) => a + b, 0) - 1) < 1e-6);
check("the plan's dimensions are ones the strategy weighs", (plan.applied?.dims ?? []).every((dim) => typeof record.weights[dim] === "number"));
check("the panel has an explanation to show", (record.notes ?? []).length > 0);
check("a cost was estimated", typeof plan.costUsd === "number" && plan.costUsd > 0, `$${plan.costUsd ?? "?"}`);

// A second move should reuse the cached plan rather than ask again, which is the cost argument.
const secondHuman = await api(`/api/games/${gameId}/moves`, { method: "POST", body: { from: "g1", to: "f3" } });
if (secondHuman.status === 200) {
  const before = (await api(`/api/games/${gameId}`)).json.game.llm.reviews;
  const deadline = Date.now() + 180_000;
  let after = before;
  while (Date.now() < deadline) {
    const polled = (await api(`/api/games/${gameId}`)).json.game;
    if (polled.history.length >= 4) {
      after = polled.llm.reviews;
      break;
    }
    await sleep(750);
  }
  console.log(`\nCaching: ${before} review(s) after move one, ${after} after move two`);
  check("the second move did not necessarily need a new plan", after <= before + 1, `${before} → ${after}`);
}

const totals = (await api(`/api/games/${gameId}`)).json.game.llm;
console.log(`\n  game totals: ${totals.reviews} review(s), ${totals.tokens} tokens, $${totals.costUsd}`);

console.log(
  failures === 0
    ? "\nThe strategy layer is planning for real, and its plan reaches the move."
    : `\n${failures} problem(s) — see above.`,
);
process.exit(failures === 0 ? 0 : 1);
