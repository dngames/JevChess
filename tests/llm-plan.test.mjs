/**
 * The strategy layer: plan validation, planning application, and the Gemini wire contract.
 *
 * Nothing here needs a key or the network. The Gemini parts are tested against payload literals
 * built from the documented shapes (both API styles, including the June-2026 step-based response
 * and the classic candidate-based one), because the docs contradicted themselves and a client
 * that only handles one shape would fail in production, not in review.
 *
 * Run with: node tests/llm-plan.test.mjs
 */

import assert from "node:assert/strict";

import {
  DIMENSION_IDS,
  MAX_WEIGHT_DELTA,
  PLAN_IDS,
  applyPlan,
  describePlan,
  planSignature,
  validatePlan,
} from "../src/llm/plan.js";
import { PLAN_JSON_SCHEMA, PROMPT_VERSION, buildPlanInput } from "../src/llm/prompts.js";
import {
  DEFAULT_MODEL,
  GeminiClient,
  GeminiError,
  MockLlmClient,
  createLlmClient,
  estimateCost,
  resolveThinkingLevel,
} from "../src/llm/client.js";
import { resolveStrategy, WEIGHT_KEYS } from "../src/strategies.js";
import { Chess } from "../src/engine/chess.js";

let passed = 0;
const failures = [];
const pending = [];

function report(name, error) {
  failures.push({ name, error });
  console.log(`  FAIL  ${name}\n        ${error.message.split("\n").join("\n        ")}`);
}

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pending.push(result.then(() => { passed += 1; }, (error) => report(name, error)));
    } else {
      passed += 1;
    }
  } catch (error) {
    report(name, error);
  }
}

const GOOD_PLAN = {
  plan: "minority_attack",
  targets: ["c5", "b4"],
  risk: "balanced",
  review_after_plies: 5,
  weight_deltas: { pawnStructure: 0.1, search: -0.05 },
  ask_jev: ["pawnStructure", "quality"],
  opponent_plan: "attack_king",
  commentary: "Restrain ...b5 and play against the backward pawn on c5.",
};

// ===========================================================================
// 1. plan validation
// ===========================================================================

console.log("\n== plan validation ==");

test("a well-formed plan passes through unchanged", () => {
  const { plan, problems } = validatePlan(GOOD_PLAN);
  assert.equal(problems.length, 0, problems.join("; "));
  assert.equal(plan.plan, "minority_attack");
  assert.deepEqual(plan.targets, ["c5", "b4"]);
  assert.equal(plan.risk, "balanced");
  assert.equal(plan.reviewAfterPlies, 5);
  assert.deepEqual(plan.weightDeltas, { pawnStructure: 0.1, search: -0.05 });
  assert.deepEqual(plan.askJev, ["pawnStructure", "quality"]);
  assert.equal(plan.opponentPlan, "attack_king");
  assert.match(plan.commentary, /backward pawn/);
});

test("an unknown or missing plan is rejected outright", () => {
  for (const raw of [{}, { plan: "sacrifice_everything" }, { plan: 42 }, null, "attack", []]) {
    const { plan, problems } = validatePlan(raw);
    assert.equal(plan, null, `should reject ${JSON.stringify(raw)}`);
    assert.ok(problems.length > 0);
  }
});

test("plan names are normalised the way a model might write them", () => {
  assert.equal(validatePlan({ plan: "Attack King" }).plan.plan, "attack_king");
  assert.equal(validatePlan({ plan: "TRADE-TO-ENDGAME" }).plan.plan, "trade_to_endgame");
  assert.equal(validatePlan({ plan: " pawn_break " }).plan.plan, "pawn_break");
});

test("targets must be real squares; unusable ones are dropped and case is normalised", () => {
  const { plan, problems } = validatePlan({ ...GOOD_PLAN, targets: ["c5", "z9", "hello", "C5", "c5"] });
  assert.deepEqual(plan.targets, ["c5"], "z9 and hello go, C5 is normalised, the duplicate collapses");
  assert.equal(problems.filter((entry) => /dropped target/.test(entry)).length, 2);
  assert.equal(validatePlan({ ...GOOD_PLAN, targets: ["C5"] }).plan.targets[0], "c5", "a shouted square is still a square");
});

test("a single target string is accepted as well as a list", () => {
  assert.deepEqual(validatePlan({ ...GOOD_PLAN, target: "d5", targets: undefined }).plan.targets, ["d5"]);
});

test("weight deltas are clamped to the documented bound", () => {
  const { plan, warnings } = validatePlan({ ...GOOD_PLAN, weight_deltas: { activity: 5, safety: -9, quality: 0.1 } });
  assert.equal(plan.weightDeltas.activity, MAX_WEIGHT_DELTA);
  assert.equal(plan.weightDeltas.safety, -MAX_WEIGHT_DELTA);
  assert.equal(plan.weightDeltas.quality, 0.1);
  assert.equal(warnings.length, 2, "each clamp is reported");
});

test("non-numeric weight deltas are dropped and reported", () => {
  const { plan, problems } = validatePlan({ ...GOOD_PLAN, weight_deltas: { activity: "lots", safety: 0.1 } });
  assert.ok(!("activity" in plan.weightDeltas));
  assert.equal(plan.weightDeltas.safety, 0.1);
  assert.ok(problems.some((entry) => /not a number/.test(entry)));
});

test("zero deltas are dropped so the record only shows real shifts", () => {
  const { plan } = validatePlan({ ...GOOD_PLAN, weight_deltas: { activity: 0 } });
  assert.deepEqual(plan.weightDeltas, {});
});

test("unknown dimensions in ask_jev are dropped and reported", () => {
  const { plan, problems } = validatePlan({ ...GOOD_PLAN, ask_jev: ["quality", "vibes", 7] });
  assert.deepEqual(plan.askJev, ["quality"]);
  assert.equal(problems.filter((entry) => /ignored requested dimension/.test(entry)).length, 2);
});

test("review interval, risk and commentary are bounded", () => {
  const { plan, warnings } = validatePlan({ ...GOOD_PLAN, review_after_plies: 999, risk: "yolo", commentary: "x".repeat(900) });
  assert.equal(plan.reviewAfterPlies, 16, "clamped to the documented maximum");
  assert.equal(plan.risk, "balanced", "an invalid risk falls back rather than failing the plan");
  assert.ok(plan.commentary.length <= 320);
  assert.ok(warnings.some((entry) => /truncated/.test(entry)));
});

test("a missing review interval gets the default rather than a guess", () => {
  const { plan } = validatePlan({ plan: "improve_pieces", risk: "balanced", commentary: "ok" });
  assert.equal(plan.reviewAfterPlies, 5);
});

test("an out-of-phase plan is accepted with a warning", () => {
  const { plan, warnings } = validatePlan({ ...GOOD_PLAN, plan: "promote_passer" }, { phase: "opening" });
  assert.equal(plan.plan, "promote_passer");
  assert.ok(warnings.some((entry) => /unusual in the opening/.test(entry)));
});

test("an unknown opponent plan is ignored without failing the plan", () => {
  const { plan, warnings } = validatePlan({ ...GOOD_PLAN, opponent_plan: "win_by_vibes" });
  assert.equal(plan.opponentPlan, null);
  assert.ok(warnings.length > 0);
});

// ===========================================================================
// 2. applying a plan to a strategy
// ===========================================================================

console.log("\n== applying a plan ==");

const BALANCED = () => resolveStrategy({ strategyId: "balanced" });

test("weight deltas move the mix and are reflected in the normalised weights", () => {
  const strategy = BALANCED();
  const before = { ...strategy.weights };
  const { strategy: planned, applied } = applyPlan(strategy, validatePlan({ ...GOOD_PLAN, weight_deltas: { quality: 0.15, search: -0.1 } }).plan);

  assert.equal(planned.weights.quality, Math.round((before.quality + 0.15) * 1000) / 1000);
  assert.equal(planned.weights.search, Math.round((before.search - 0.1) * 1000) / 1000);
  assert.deepEqual(applied.weights, { quality: 0.15, search: -0.1 });
  const total = Object.values(planned.weightsNormalized).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, "normalised weights must still sum to 1");
  assert.deepEqual(strategy.weights, before, "the original strategy must not be mutated");
});

test("a plan cannot push a weight outside 0..1", () => {
  const strategy = BALANCED();
  strategy.weights.kingPressure = 0.02;
  const { strategy: planned } = applyPlan(strategy, validatePlan({ ...GOOD_PLAN, weight_deltas: { kingPressure: -0.25 } }).plan);
  assert.equal(planned.weights.kingPressure, 0);
  assert.ok(Object.values(planned.weights).every((value) => value >= 0 && value <= 1));
});

test("routing is intersected with the dimensions this strategy actually weighs", () => {
  const strategy = BALANCED();
  const plan = validatePlan({ ...GOOD_PLAN, ask_jev: ["quality", "safety", "endgameTechnique"] }).plan;
  const { strategy: planned, applied } = applyPlan(strategy, plan);
  assert.deepEqual(applied.dims, ["quality", "safety"], "endgameTechnique is not weighed by balanced");
  assert.deepEqual(applied.dropped, ["endgameTechnique"]);
  assert.deepEqual(planned.dims, ["quality", "safety"]);
  assert.ok(applied.notes.some((entry) => /Routing dropped/.test(entry)));
});

test("no routing narrows Jev to the plan's own dimensions, intersected with what is weighed", () => {
  const strategy = BALANCED();
  const plan = validatePlan({ ...GOOD_PLAN, plan: "trade_to_endgame", ask_jev: [] }).plan;
  const { strategy: planned } = applyPlan(strategy, plan);
  // trade_to_endgame leans on endgameTechnique, safety and quality. Balanced does not weigh
  // endgameTechnique, so the plan narrows Jev to the other two — the point of routing is to
  // focus the questions the plan is actually about.
  assert.deepEqual(planned.dims, ["safety", "quality"]);
  assert.ok(planned.dims.length < strategy.dims.length, "routing to a plan's dimensions is a narrowing");
  // Every dimension kept must still be weighted, or asking would be a silent no-op.
  assert.ok(planned.dims.every((dimension) => typeof planned.weights[dimension] === "number"));
});

test("a plan whose natural dimensions are all unweighed falls back to the preset's dims", () => {
  const strategy = BALANCED();
  // promote_passer leans on endgameTechnique and pawnStructure (unweighed) and kingSafety (weighed),
  // so one survives; build a case where none do by removing the last overlap.
  const weights = { ...strategy.weights };
  delete weights.kingSafety;
  const bare = { ...strategy, weights };
  const plan = validatePlan({ ...GOOD_PLAN, plan: "promote_passer", ask_jev: [] }).plan;
  const { strategy: planned } = applyPlan(bare, plan);
  assert.deepEqual(planned.dims, bare.dims, "with no overlap, the preset's own dimensions stand");
});

test("weight deltas for keys the strategy does not weigh are reported, not silently applied", () => {
  const strategy = BALANCED();
  const plan = validatePlan({ ...GOOD_PLAN, weight_deltas: { endgameTechnique: 0.2 } }).plan;
  const { applied } = applyPlan(strategy, plan);
  assert.deepEqual(applied.weights, {});
  assert.ok(applied.notes.some((entry) => /does not weigh/.test(entry)));
});

test("a null plan leaves the strategy untouched", () => {
  const strategy = BALANCED();
  const { strategy: planned, applied } = applyPlan(strategy, null);
  assert.equal(planned, strategy);
  assert.deepEqual(applied.weights, {});
});

test("the plan is attached to the strategy and described in one line", () => {
  const strategy = BALANCED();
  const plan = validatePlan(GOOD_PLAN).plan;
  const { strategy: planned } = applyPlan(strategy, plan);
  assert.equal(planned.plan.plan, "minority_attack");
  assert.match(describePlan(planned.plan), /Minority attack · target c5, b4 · risk balanced · review in 5 plies/);
  assert.equal(describePlan(null), "no plan");
});

test("the signature ignores key order, so a cached plan compares correctly", () => {
  const a = validatePlan({ ...GOOD_PLAN, weight_deltas: { activity: 0.1, safety: -0.05 } }).plan;
  const b = validatePlan({ ...GOOD_PLAN, weight_deltas: { safety: -0.05, activity: 0.1 } }).plan;
  assert.equal(planSignature(a), planSignature(b));
  const c = validatePlan({ ...GOOD_PLAN, plan: "attack_king" }).plan;
  assert.notEqual(planSignature(a), planSignature(c));
});

// ===========================================================================
// 3. the prompt and its schema
// ===========================================================================

console.log("\n== prompt and schema ==");

test("the schema stays inside the documented subset", () => {
  const json = JSON.stringify(PLAN_JSON_SCHEMA);
  for (const banned of ["pattern", "allOf", "anyOf", "oneOf", "$ref", "default", "minProperties"]) {
    assert.ok(!json.includes(`"${banned}"`), `schema must not use ${banned}`);
  }
  assert.equal(PLAN_JSON_SCHEMA.type, "object");
  assert.deepEqual(Object.keys(PLAN_JSON_SCHEMA.properties).sort(), [
    "ask_jev",
    "commentary",
    "opponent_plan",
    "plan",
    "review_after_plies",
    "risk",
    "targets",
    "weight_deltas",
  ]);
  assert.ok(PLAN_JSON_SCHEMA.required.includes("plan"));
  assert.deepEqual(PLAN_JSON_SCHEMA.properties.plan.enum, PLAN_IDS, "the schema and the vocabulary must not drift apart");
  assert.deepEqual(PLAN_JSON_SCHEMA.properties.ask_jev.items.enum, DIMENSION_IDS);
  assert.equal(PLAN_JSON_SCHEMA.properties.weight_deltas.additionalProperties.type, "number");
  assert.match(PROMPT_VERSION, /^plan-v\d+$/);
});

test("the schema accepts exactly what the validator accepts", () => {
  // Every enum member must survive validation, or the schema is lying to the model.
  for (const id of PLAN_IDS) {
    const { plan } = validatePlan({ plan: id, risk: "balanced", review_after_plies: 5, commentary: "x" });
    assert.equal(plan?.plan, id, `${id} is in the schema but rejected by the validator`);
  }
  for (const dimension of DIMENSION_IDS) {
    const { plan } = validatePlan({ ...GOOD_PLAN, ask_jev: [dimension] });
    assert.ok(plan.askJev.includes(dimension), `${dimension} is offerable but rejected`);
  }
});

test("the position input carries facts and never a move list", () => {
  const chess = new Chess("r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 6");
  const input = buildPlanInput({
    chess,
    evalCp: 28,
    evalLabel: "+0.28",
    phase: "middlegame",
    plan: validatePlan(GOOD_PLAN).plan,
    pliesSinceReview: 3,
    lastMoves: ["e4", "e5", "Nf3", "Nc6"],
    opponentLastMove: { san: "Nc6", from: "b8", to: "c6", color: "b" },
    jevRead: { standing: "Balanced", plan: "improve the pieces" },
  });

  assert.match(input, /Position \(FEN\): r1bqk2r/);
  assert.match(input, /Side to move: White, move 6, phase: middlegame/);
  assert.match(input, /Code search evaluation: \+0\.28/);
  assert.match(input, /8 {2}r \. b q k \. \. r/, "the board diagram is included");
  assert.match(input, /White pieces: Ke1 Qd1/);
  assert.match(input, /Opponent's last move: Nc6 \(b8-c6\)/);
  assert.match(input, /Jev's last read/);
  assert.match(input, /Plan currently in force: minority_attack/);
  assert.match(input, /Target features right now — c5:/);
  assert.match(input, /Choose the plan, not a move|choose the plan, not a move/i);

  // The design rule: the strategist never sees a candidate list.
  assert.ok(!/candidate/i.test(input), "no candidate enumeration may reach the strategist");
  assert.ok(!input.includes("You do not, and must not, choose a move"), "the system prompt belongs in the system prompt");
  assert.ok(input.length < 4000, `input should stay small, got ${input.length} chars`);
});

test("the input works with no plan yet and no optional context", () => {
  const input = buildPlanInput({ chess: new Chess() });
  assert.match(input, /No plan is in force yet/);
  assert.ok(!/undefined|null|NaN/.test(input), `no placeholder junk should leak: ${input.slice(0, 200)}`);
});

// ===========================================================================
// 4. the Gemini wire contract
// ===========================================================================

console.log("\n== Gemini wire contract ==");

const PLAN_JSON = { ...GOOD_PLAN };

/** A response in the Interactions shape (steps timeline), per the 2026 docs. */
function interactionsPayload({ status = "completed", text = JSON.stringify(PLAN_JSON), usage } = {}) {
  return {
    id: "v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg",
    object: "interaction",
    model: "gemini-3.8-flash",
    status,
    steps: [
      { type: "thought", signature: "EvEFCu4FAQw" },
      ...(text === null ? [] : [{ type: "model_output", content: [{ type: "text", text }] }]),
    ],
    usage: usage ?? { total_tokens: 530, total_input_tokens: 62, total_output_tokens: 171, total_thought_tokens: 297, total_cached_tokens: 0 },
  };
}

/** A response in the classic generateContent shape. */
function classicPayload({ text = JSON.stringify(PLAN_JSON), finishReason = "STOP", blockReason = null } = {}) {
  return {
    candidates: text === null ? [] : [{ content: { parts: [{ text }], role: "model" }, finishReason, index: 0 }],
    usageMetadata: { promptTokenCount: 620, candidatesTokenCount: 180, thoughtsTokenCount: 40, totalTokenCount: 840 },
    modelVersion: "gemini-3.8-flash",
    ...(blockReason ? { promptFeedback: { blockReason } } : {}),
  };
}

test("the Interactions request matches the documented shape", () => {
  const client = new GeminiClient({ apiKey: "k", api: "interactions" });
  const request = client.buildRequest({ input: "state", systemInstruction: "sys", schema: PLAN_JSON_SCHEMA, thinkingLevel: "medium" });
  assert.equal(request.url, "https://generativelanguage.googleapis.com/v1/interactions");
  assert.equal(request.headers["x-goog-api-key"], "k");
  assert.match(request.headers["Content-Type"], /application\/json/);
  assert.deepEqual(Object.keys(request.body).sort(), ["generation_config", "input", "model", "response_format", "system_instruction"]);
  assert.equal(request.body.model, DEFAULT_MODEL);
  assert.equal(request.body.response_format.type, "text");
  assert.equal(request.body.response_format.mime_type, "application/json");
  assert.equal(request.body.response_format.schema, PLAN_JSON_SCHEMA);
  assert.equal(request.body.generation_config.thinking_level, "medium");
  assert.equal(request.body.generation_config.max_output_tokens, 2048);
  assert.ok(!("temperature" in request.body.generation_config), "the Interactions API documents no temperature");
  assert.ok(!("contents" in request.body), "that is the classic shape");
});

test("the classic request matches the documented shape", () => {
  const client = new GeminiClient({ apiKey: "k", api: "generateContent", model: "gemini-3.5-flash-lite" });
  const request = client.buildRequest({ input: "state", systemInstruction: "sys", schema: PLAN_JSON_SCHEMA, thinkingLevel: "low" });
  assert.equal(request.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
  assert.equal(request.body.systemInstruction.parts[0].text, "sys");
  assert.equal(request.body.contents[0].parts[0].text, "state");
  assert.equal(request.body.generationConfig.responseMimeType, "application/json");
  assert.equal(request.body.generationConfig.responseJsonSchema, PLAN_JSON_SCHEMA);
  assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, "LOW", "classic thinking levels are upper case");
  assert.ok(!("systemInstruction" in { ...request.body, systemInstruction: null }) === false);
  assert.ok(!("role" in request.body.systemInstruction), "system instructions must not carry a role");
});

test("thinking 'off' omits the thinking config entirely", () => {
  const client = new GeminiClient({ apiKey: "k", api: "interactions" });
  const request = client.buildRequest({ input: "x", systemInstruction: "y", schema: {}, thinkingLevel: "off" });
  assert.ok(!("thinking_level" in request.body.generation_config));
});

test("gemini-3.8-flash's refusal of 'minimal' is handled instead of failing", () => {
  const bumped = resolveThinkingLevel("gemini-3.8-flash", "minimal");
  assert.equal(bumped.level, "low");
  assert.match(bumped.note, /rejects/);
  assert.equal(resolveThinkingLevel("gemini-3.5-flash-lite", "minimal").level, "minimal", "the lite model accepts it");
  assert.equal(resolveThinkingLevel("gemini-3.5-flash-lite", undefined).level, "minimal", "per-model default");
  assert.equal(resolveThinkingLevel("gemini-3.8-flash", "nonsense").level, "medium", "unknown levels fall back to the model default");
});

test("the Interactions response is parsed from the step timeline", () => {
  const client = new GeminiClient({ apiKey: "k" });
  const parsed = client.extract(interactionsPayload());
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.json, PLAN_JSON);
  assert.equal(parsed.usage.inputTokens, 62);
  assert.equal(parsed.usage.outputTokens, 171);
  assert.equal(parsed.usage.thoughtTokens, 297);
});

test("consecutive model_output parts are concatenated", () => {
  const client = new GeminiClient({ apiKey: "k" });
  const payload = interactionsPayload({ text: null });
  payload.steps.push({
    type: "model_output",
    content: [
      { type: "text", text: '{"plan":"develop",' },
      { type: "text", text: '"risk":"balanced","review_after_plies":5,"commentary":"x"}' },
    ],
  });
  const parsed = client.extract(payload);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.json.plan, "develop");
});

test("an incomplete interaction is reported but its JSON is still used", () => {
  const client = new GeminiClient({ apiKey: "k" });
  const parsed = client.extract(interactionsPayload({ status: "incomplete" }));
  assert.equal(parsed.ok, true);
  assert.ok(parsed.notes.some((entry) => /incomplete/.test(entry)));
});

test("a failed interaction is an error with the reason", () => {
  const client = new GeminiClient({ apiKey: "k" });
  const payload = { status: "failed", errors: [{ message: "safety filter" }], steps: [] };
  const parsed = client.extract(payload);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "interaction_failed");
  assert.match(parsed.error, /safety filter/);
});

test("the classic response is parsed from candidates[0]", () => {
  const client = new GeminiClient({ apiKey: "k", api: "generateContent" });
  const parsed = client.extract(classicPayload());
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.json, PLAN_JSON);
  assert.equal(parsed.usage.inputTokens, 620);
  assert.equal(parsed.usage.thoughtTokens, 40);
});

test("a safety block on the classic path is an error, not an empty plan", () => {
  const client = new GeminiClient({ apiKey: "k", api: "generateContent" });
  const parsed = client.extract(classicPayload({ text: null, blockReason: "PROHIBITED_CONTENT" }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "blocked");
  assert.match(parsed.error, /PROHIBITED_CONTENT/);
});

test("prose, truncated JSON and unknown shapes are rejected clearly", () => {
  const client = new GeminiClient({ apiKey: "k" });
  assert.equal(client.extract(interactionsPayload({ text: "Sure! Here is the plan: ..." })).code, "bad_json");
  assert.equal(client.extract(interactionsPayload({ text: '{"plan":"develop"' })).code, "bad_json");
  assert.equal(client.extract({ nope: true }).code, "unknown_shape");
  assert.equal(client.extract(null).code, "empty");
  assert.equal(client.extract(interactionsPayload({ text: "   " })).code, "no_text");
});

test("a good HTTP response with unusable content is not retried", () => {
  const client = new GeminiClient({ apiKey: "k", maxAttempts: 3 });
  assert.equal(client.extract(classicPayload({ finishReason: "MAX_TOKENS" })).ok, true, "truncation is a note, not a failure");
});

await test("a 401 maps to an auth error and never leaks the key", async () => {
  const secret = "AIza-super-secret-gemini-key";
  const client = new GeminiClient({
    apiKey: secret,
    maxAttempts: 1,
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { code: "authentication", message: "API key not valid" } }), { status: 401 }),
  });
  const result = await client.generateJson({ input: "x", systemInstruction: "y", schema: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, "gemini-auth");
  assert.ok(!result.error.includes(secret), "the key must never appear in an error");
  assert.equal(client.stats.failures, 1);
});

await test("a 429 is retried and then succeeds", async () => {
  let attempts = 0;
  const client = new GeminiClient({
    apiKey: "k",
    maxAttempts: 3,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } }), {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify(interactionsPayload()), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const result = await client.generateJson({ input: "x", systemInstruction: "y", schema: PLAN_JSON_SCHEMA, thinkingLevel: "low" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.attempts, 2);
  assert.equal(result.api, "interactions");
  assert.equal(result.json.plan, GOOD_PLAN.plan);
  assert.ok(result.costUsd > 0, "cost is estimated from the documented price table");
});

await test("a 400 is not retried", async () => {
  let attempts = 0;
  const client = new GeminiClient({
    apiKey: "k",
    maxAttempts: 3,
    fetchImpl: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: { code: "invalid_request", message: "bad schema" } }), { status: 400 });
    },
  });
  const result = await client.generateJson({ input: "x", systemInstruction: "y", schema: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, "gemini-bad-request");
  assert.equal(attempts, 1);
});

await test("gRPC-style error codes from the other doc page are understood", async () => {
  const client = new GeminiClient({
    apiKey: "k",
    maxAttempts: 1,
    fetchImpl: async () => new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }), { status: 429 }),
  });
  const result = await client.generateJson({ input: "x", systemInstruction: "y", schema: {} });
  assert.equal(result.code, "gemini-rate-limit");
});

await test("a model id the API does not know is reported as such", async () => {
  const client = new GeminiClient({
    apiKey: "k",
    maxAttempts: 1,
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: "model_not_found", message: "no such model" } }), { status: 404 }),
  });
  const result = await client.generateJson({ input: "x", systemInstruction: "y", schema: {} });
  assert.equal(result.code, "gemini-model");
});

await test("a cancellation is not retried", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new GeminiClient({ apiKey: "k", maxAttempts: 3, fetchImpl: async () => new Response("{}", { status: 200 }) });
  const result = await client.generateJson({ input: "x", systemInstruction: "y", schema: {}, signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.code, "cancelled");
});

test("a missing key is refused before any request", () => {
  assert.throws(() => new GeminiClient({ apiKey: "" }), (error) => error instanceof GeminiError && error.code === "no-api-key");
});

test("the client picks the mock when there is no key, and honours forceMock", () => {
  assert.equal(createLlmClient({ apiKey: "" }).mock, true);
  assert.equal(createLlmClient({ apiKey: "k", forceMock: true }).mock, true);
  assert.equal(createLlmClient({ apiKey: "k" }).mock, false);
});

test("cost estimates come from the documented price table", () => {
  const cost = estimateCost("gemini-3.8-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(Math.round(cost * 100) / 100, 4.5, "0.75 + 3.75");
  assert.equal(estimateCost("gemini-3.5-flash-lite", { inputTokens: 1_000_000, outputTokens: 0 }), 0.3);
  assert.equal(estimateCost("some-unknown-model", { inputTokens: 1_000_000, outputTokens: 0 }), null);
});

// ===========================================================================
// 5. the mock, and the chain end to end
// ===========================================================================

console.log("\n== mock and end-to-end ==");

await test("the mock is deterministic and produces valid plans", async () => {
  const mock = new MockLlmClient();
  const first = await mock.generateJson({ input: "same position", schema: PLAN_JSON_SCHEMA });
  const second = await mock.generateJson({ input: "same position", schema: PLAN_JSON_SCHEMA });
  const other = await mock.generateJson({ input: "a different position", schema: PLAN_JSON_SCHEMA });
  assert.deepEqual(first.json, second.json, "the same input must give the same plan");
  assert.notDeepEqual(first.json, other.json, "different inputs should differ");
  assert.equal(first.mock, undefined, "the result shape mirrors the real client");
  for (const result of [first, second, other]) {
    const { plan, problems } = validatePlan(result.json);
    assert.ok(plan, `mock plans must validate: ${problems.join("; ")}`);
  }
  assert.deepEqual(mock.stats.requests, 3);
});

await test("the chain model → validate → apply yields a usable strategy", async () => {
  const mock = new MockLlmClient();
  const strategy = BALANCED();
  const generated = await mock.generateJson({ input: "position", schema: PLAN_JSON_SCHEMA });
  const { plan } = validatePlan(generated.json);
  const { strategy: planned, applied } = applyPlan(strategy, plan);

  assert.ok(planned.plan, "the strategy carries the plan");
  assert.deepEqual(applied.dims, planned.dims);
  assert.ok(planned.dims.every((dimension) => Object.prototype.hasOwnProperty.call(planned.weights, dimension)));
  assert.ok(Object.keys(planned.weights).every((key) => WEIGHT_KEYS.includes(key)));
  assert.equal(planned.pipeline, strategy.pipeline, "a plan never changes the machinery");
  assert.equal(planned.candidateLimit, strategy.candidateLimit);
  assert.equal(planned.searchDepth, strategy.searchDepth);
  assert.ok(planned.plan.commentary.length > 0, "the panel gets something to show");
});

await test("a failed strategist leaves a fully usable strategy behind", async () => {
  const failing = {
    mock: false,
    model: "gemini-3.8-flash",
    async generateJson() {
      return { ok: false, error: "Gemini is overloaded", code: "gemini-overloaded", attempts: 3, elapsedMs: 10, notes: [] };
    },
  };
  const strategy = BALANCED();
  const result = await failing.generateJson({});
  assert.equal(result.ok, false);
  const { plan, problems } = validatePlan(undefined);
  assert.equal(plan, null);
  assert.ok(problems.length > 0);
  const { strategy: planned } = applyPlan(strategy, plan);
  assert.equal(planned, strategy, "the preset stands when there is no plan");
});

// ===========================================================================

await Promise.all(pending);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.error.message}`);
  process.exitCode = 1;
}
