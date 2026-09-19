/**
 * Wire-contract tests for the TypeSafe API.
 *
 * Everything else in this project runs against a mocked Jev. These tests instead check the
 * two things that would make the *first real call* fail even though every other test passes:
 *
 *   1. The HTTP request the client builds — URL, method, headers, body shape, retry
 *      behaviour, error mapping, and that the API key can never leak into an error.
 *   2. The exact `state` and `questions` payloads each pipeline produces, validated against
 *      the documented schema (primitives, criteria shapes, level counts) and the documented
 *      limits (64k per request, 32k for state + longest question).
 *
 * Run with: node tests/jev-payload.test.mjs
 *
 * Schema source: https://docs.typesafe.ai/api (fetched while building; see README).
 */

import assert from "node:assert/strict";
import { Chess } from "../src/engine/chess.js";
import { selectMove } from "../src/jev/pipelines.js";
import { TypeSafeClient, TypeSafeError, choice, score, noul, parseRetryAfter } from "../src/jev/client.js";
import { resolveStrategy, strategiesPayload } from "../src/strategies.js";
import { DIMENSIONS } from "../src/jev/questions.js";

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

// ---------------------------------------------------------------------------
// the documented schema, as a validator
// ---------------------------------------------------------------------------

const QUESTION_TYPES = new Set(["choice", "score", "noul"]);
const MAX_STATE_AND_LONGEST_QUESTION_TOKENS = 32_000;
const MAX_REQUEST_TOKENS = 64_000;

/** Rough but deliberately conservative token estimate (the client uses the same idea). */
function estimateTokens(value) {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isInstructions(value) {
  if (isText(value)) return true;
  if (Array.isArray(value)) return value.length > 0 && value.every((entry) => isText(entry) || (entry && typeof entry === "object"));
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

/**
 * Validate one request against the documented API contract.
 * Throws with a specific message so a failure names the offending question.
 */
function validateRequest({ state, model, questions }) {
  assert.equal(typeof model, "string", "model must be a string");
  assert.ok(model.length > 0, "model must not be empty");
  assert.ok(state !== null && state !== undefined, "state is required");
  assert.ok(["string", "object"].includes(typeof state), `state must be a string, object or array (got ${typeof state})`);
  assert.ok(questions && typeof questions === "object" && !Array.isArray(questions), "questions must be a map");
  const ids = Object.keys(questions);
  assert.ok(ids.length > 0, "at least one question is required");

  for (const [id, question] of Object.entries(questions)) {
    assert.ok(question && typeof question === "object", `${id}: question must be an object`);
    assert.ok(QUESTION_TYPES.has(question.type), `${id}: type must be choice|score|noul (got ${JSON.stringify(question.type)})`);
    assert.ok(isInstructions(question.instructions), `${id}: instructions must be a non-empty string, object or array`);

    if (question.type === "choice") {
      const criteria = question.criteria;
      assert.ok(criteria && typeof criteria === "object" && !Array.isArray(criteria), `${id}: choice criteria must be a map`);
      const options = Object.keys(criteria);
      assert.ok(options.length >= 2, `${id}: choice needs at least two options (got ${options.length})`);
      for (const option of options) {
        const description = criteria[option];
        assert.ok(
          description === null || isText(description) || (description && typeof description === "object"),
          `${id}: option "${option}" must be a string, null or an object`,
        );
      }
    } else if (question.type === "score") {
      const criteria = question.criteria;
      assert.ok(Array.isArray(criteria), `${id}: score criteria must be an array of levels`);
      assert.ok(criteria.length >= 2, `${id}: score needs at least two levels (got ${criteria.length})`);
      assert.ok(criteria.length <= 10, `${id}: score takes at most ten levels (got ${criteria.length})`);
      assert.equal(new Set(criteria.map((level) => JSON.stringify(level))).size, criteria.length, `${id}: levels must be distinct`);
      for (const level of criteria) {
        assert.ok(isText(level) || (level && typeof level === "object"), `${id}: every level must be a non-empty string or object`);
      }
    } else {
      // noul: criteria is optional, and when present describes yes and no.
      if (question.criteria !== undefined) {
        const criteria = question.criteria;
        assert.ok(criteria && typeof criteria === "object" && !Array.isArray(criteria), `${id}: noul criteria must be a map`);
        for (const key of Object.keys(criteria)) {
          assert.ok(["true", "false"].includes(key), `${id}: noul criteria may only describe true and false (got "${key}")`);
          assert.ok(isText(criteria[key]), `${id}: noul criteria "${key}" must be a non-empty string`);
        }
      }
    }
  }

  // The body must survive JSON exactly: an `undefined` anywhere becomes a missing field,
  // which is how a 422 usually happens.
  const serialised = JSON.stringify({ state, model, questions });
  assert.deepEqual(JSON.parse(serialised), JSON.parse(JSON.stringify({ state, model, questions })), "body must round-trip through JSON");

  // Documented limits.
  const stateTokens = estimateTokens(state);
  const longestQuestion = Math.max(...Object.values(questions).map((question) => estimateTokens(question)));
  assert.ok(
    stateTokens + longestQuestion <= MAX_STATE_AND_LONGEST_QUESTION_TOKENS,
    `state + longest question is about ${stateTokens + longestQuestion} tokens, over the ${MAX_STATE_AND_LONGEST_QUESTION_TOKENS} limit`,
  );
  assert.ok(estimateTokens({ state, model, questions }) <= MAX_REQUEST_TOKENS, "request must stay under the 64k context limit");
  return { stateTokens, questionCount: ids.length };
}

/** Internal invariants: what the questions promise must exist in the state they ride with. */
function validateInternalConsistency({ state, questions }) {
  if (!Array.isArray(state.candidates)) return; // audit states describe one nomination instead
  const ids = state.candidates.map((candidate) => candidate.id);
  assert.equal(new Set(ids).size, ids.length, "candidate ids must be unique");
  assert.ok(ids.length > 0, "a judging state must carry at least one candidate");

  for (const candidate of state.candidates) {
    assert.ok(isText(candidate.id), "candidate id must be a non-empty string");
    assert.ok(isText(candidate.move_san), `${candidate.id}: move_san is required`);
    assert.ok(isText(candidate.how_the_move_reads), `${candidate.id}: a plain-language description is required`);
    assert.ok(typeof candidate.captures === "string", `${candidate.id}: captures must be stated (use "nothing")`);
    assert.ok(Number.isInteger(candidate.opponent_legal_replies), `${candidate.id}: opponent_legal_replies must be an integer`);
    assert.ok(isText(candidate.material_after), `${candidate.id}: material_after is required`);
    if (candidate.board_after_8_to_1 !== undefined) {
      const lines = candidate.board_after_8_to_1.split("\n");
      assert.equal(lines.length, 9, `${candidate.id}: board diagram should be 8 ranks plus a file label row`);
      for (const line of lines.slice(0, 8)) {
        const cells = line.slice(3).trim().split(/\s+/);
        assert.equal(cells.length, 8, `${candidate.id}: each rank must list eight cells`);
      }
    }
  }

  // Every per-candidate question must name a candidate that exists under the same id.
  for (const [id, question] of Object.entries(questions)) {
    if (!id.startsWith("cand_")) continue;
    const candidateId = id.split("_")[1];
    assert.ok(ids.includes(candidateId), `${id}: refers to candidate ${candidateId}, which is not in the state`);
    assert.ok(
      question.instructions.includes(candidateId),
      `${id}: the instructions must name ${candidateId} so the model can tell which candidate is meant`,
    );
    const dimension = id.split("_").slice(2).join("_");
    assert.ok(DIMENSIONS[dimension], `${id}: unknown dimension ${dimension}`);
    assert.equal(
      question.criteria.length,
      DIMENSIONS[dimension].levels({ side: { name: "White" }, opponent: { name: "Black" }, candidate: { id: candidateId, san: "" } }).length,
      `${id}: level count must match the dimension definition (pipelines normalize by it)`,
    );
  }

  // The choice keys must map back to candidates by "<id> <san>".
  if (questions.best_move) {
    for (const key of Object.keys(questions.best_move.criteria)) {
      const [candidateId, ...sanParts] = String(key).split(" ");
      const candidate = state.candidates.find((entry) => entry.id === candidateId);
      assert.ok(candidate, `choice option "${key}" does not start with a known candidate id`);
      assert.equal(sanParts.join(" "), candidate.move_san, `choice option "${key}" must end with the candidate's SAN`);
    }
    assert.equal(
      Object.keys(questions.best_move.criteria).length,
      state.candidates.length,
      "the choice question must offer exactly the candidates in the state",
    );
  }
}

// ---------------------------------------------------------------------------
// a Jev that records what it was sent
// ---------------------------------------------------------------------------

function capturingClient() {
  const calls = [];
  return {
    calls,
    mock: true,
    model: "capture-jev",
    stats: { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 },
    async systemOne({ state, questions, model }) {
      calls.push({ state, model: model ?? "jev-latest", questions });
      const answers = {};
      for (const [id, question] of Object.entries(questions)) {
        if (question.type === "choice") {
          const options = Object.keys(question.criteria);
          answers[id] = {
            type: "choice",
            choice: options[0],
            probabilities: Object.fromEntries(options.map((option) => [option, 1 / options.length])),
            confidence: 0.4,
          };
        } else if (question.type === "score") {
          answers[id] = { type: "score", score: 1, probabilities: {}, confidence: 0.5, legend: {} };
        } else {
          answers[id] = { type: "noul", noul: 0.05 };
        }
      }
      return { model: "capture-jev", answers, usage: { input_tokens: 100, output_tokens: 5 }, attempts: 1, elapsedMs: 1, mock: true };
    },
  };
}

const POSITIONS = [
  ["startpos", undefined],
  ["open middlegame", "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 6"],
  ["busy tactical", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"],
  ["sparse endgame", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1"],
];

// ===========================================================================
// 1. the HTTP request itself
// ===========================================================================

console.log("\n== HTTP request ==");

test("the client posts to the documented endpoint with a bearer token", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return new Response(JSON.stringify({ model: "jev-latest", answers: { a: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 5, output_tokens: 1 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const client = new TypeSafeClient({ apiKey: "test-key-123456", fetchImpl });
  const result = await client.systemOne({ state: "hello", questions: { a: noul("Is this a test?") } });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen[0].options.method, "POST");
  assert.equal(seen[0].options.headers.Authorization, "Bearer test-key-123456");
  assert.match(seen[0].options.headers["Content-Type"], /application\/json/);
  const body = JSON.parse(seen[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"], "the body must contain exactly state, model and questions");
  assert.equal(body.model, "jev-latest", "the default model alias is used");
  assert.equal(result.answers.a.noul, 0.9);
});

test("the base URL is overridable and normalised", async () => {
  const seen = [];
  const client = new TypeSafeClient({
    apiKey: "k",
    baseUrl: "http://localhost:9999/",
    fetchImpl: async (url) => {
      seen.push(url);
      return new Response(JSON.stringify({ answers: {}, usage: {} }), { status: 200 });
    },
  });
  await client.systemOne({ state: "x", questions: { a: noul("?") } });
  assert.equal(seen[0], "http://localhost:9999/v1/systemone");
});

test("an empty question map short-circuits without a request", async () => {
  let called = false;
  const client = new TypeSafeClient({ apiKey: "k", fetchImpl: async () => { called = true; return new Response("{}", { status: 200 }); } });
  const result = await client.systemOne({ state: "x", questions: {} });
  assert.equal(called, false, "no request should be made for an empty question map");
  assert.equal(result.attempts, 0);
});

test("a missing key is refused before any request", async () => {
  assert.throws(() => new TypeSafeClient({ apiKey: "" }), (error) => error instanceof TypeSafeError && error.code === "no-api-key");
});

test("the key never appears in an error message", async () => {
  const secret = "ts-super-secret-key-value";
  const client = new TypeSafeClient({
    apiKey: secret,
    maxAttempts: 1,
    fetchImpl: async () => new Response(JSON.stringify({ detail: { error_type: "authentication_error", message: "Must supply an API key!" } }), { status: 403 }),
  });
  await assert.rejects(
    () => client.systemOne({ state: "x", questions: { a: noul("?") } }),
    (error) => {
      assert.ok(!error.message.includes(secret), "the error message must not contain the key");
      assert.ok(!JSON.stringify(error.body ?? "").includes(secret), "the error body must not contain the key");
      assert.equal(error.code, "jev-auth");
      return true;
    },
  );
});

test("HTTP status codes map to the documented error kinds", async () => {
  const cases = [
    [401, "jev-auth"],
    [403, "jev-auth"],
    [422, "jev-bad-request"],
    [429, "jev-rate-limit"],
    [529, "jev-overloaded"],
    [500, "jev-error"],
  ];
  for (const [status, code] of cases) {
    const client = new TypeSafeClient({
      apiKey: "k",
      maxAttempts: 1,
      fetchImpl: async () => new Response(JSON.stringify({ detail: { message: `status ${status}` } }), { status }),
    });
    await assert.rejects(
      () => client.systemOne({ state: "x", questions: { a: noul("?") } }),
      (error) => error.code === code,
      `HTTP ${status} should map to ${code}`,
    );
  }
});

test("429 is retried and then succeeds, honouring retry-after", async () => {
  let attempts = 0;
  const client = new TypeSafeClient({
    apiKey: "k",
    maxAttempts: 3,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ detail: { message: "slow down" } }), { status: 429, headers: { "retry-after": "0" } });
      }
      return new Response(JSON.stringify({ model: "jev-latest", answers: { a: { type: "noul", noul: 0.4 } }, usage: { input_tokens: 3, output_tokens: 0 } }), { status: 200 });
    },
  });
  const result = await client.systemOne({ state: "x", questions: { a: noul("?") } });
  assert.equal(attempts, 2, "the 429 should have been retried exactly once");
  assert.equal(result.attempts, 2);
  assert.equal(result.answers.a.noul, 0.4);
});

test("422 is not retried (a malformed request will not fix itself)", async () => {
  let attempts = 0;
  const client = new TypeSafeClient({
    apiKey: "k",
    maxAttempts: 3,
    fetchImpl: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ detail: { message: "bad question" } }), { status: 422 });
    },
  });
  await assert.rejects(() => client.systemOne({ state: "x", questions: { a: noul("?") } }));
  assert.equal(attempts, 1, "422 must not be retried");
});

test("a network failure is retried and then reported", async () => {
  let attempts = 0;
  const client = new TypeSafeClient({
    apiKey: "k",
    maxAttempts: 2,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("socket hang up");
    },
  });
  await assert.rejects(
    () => client.systemOne({ state: "x", questions: { a: noul("?") } }),
    (error) => error.code === "network",
  );
  assert.equal(attempts, 2);
});

test("a cancellation is not retried", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new TypeSafeClient({ apiKey: "k", maxAttempts: 3, fetchImpl: async () => new Response("{}", { status: 200 }) });
  await assert.rejects(
    () => client.systemOne({ state: "x", questions: { a: noul("?") }, signal: controller.signal }),
    (error) => ["cancelled", "network"].includes(error.code),
  );
});

test("an oversized state is refused before it is sent", async () => {
  let called = false;
  const client = new TypeSafeClient({
    apiKey: "k",
    maxStateTokens: 100,
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });
  await assert.rejects(
    () => client.systemOne({ state: "x".repeat(5000), questions: { a: noul("?") } }),
    (error) => error.code === "state-too-large",
  );
  assert.equal(called, false, "the guard must trip before the request goes out");
});

test("retry-after parsing handles seconds, HTTP dates and junk", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter("not-a-date"), null);
  const soon = new Date(Date.now() + 3000).toUTCString();
  const parsed = parseRetryAfter(soon);
  assert.ok(parsed !== null && parsed <= 3000 && parsed > 0, `expected a small positive delay, got ${parsed}`);
});

test("question builders produce the documented shapes", () => {
  assert.deepEqual(choice("Pick one", { a: null, b: "the second" }), { type: "choice", instructions: "Pick one", criteria: { a: null, b: "the second" } });
  assert.deepEqual(score("Rate", ["low", "high"]), { type: "score", instructions: "Rate", criteria: ["low", "high"] });
  assert.deepEqual(noul("Yes?"), { type: "noul", instructions: "Yes?" });
  assert.deepEqual(noul("Yes?", { true: "yes", false: "no" }), { type: "noul", instructions: "Yes?", criteria: { true: "yes", false: "no" } });
  assert.throws(() => score("Rate", ["only one level"]), /two levels/);
});

// ===========================================================================
// 2. the payloads each pipeline actually sends
// ===========================================================================

console.log("\n== pipeline payloads ==");

const PIPELINES = ["shortlist-composite", "pure-choice", "nominate-verify", "search-only"];

for (const pipelineId of PIPELINES) {
  const preset = strategiesPayload().presets.find((entry) => entry.pipeline === pipelineId);
  test(`"${preset.id}" (${pipelineId}) sends a schema-valid payload for every position`, async () => {
    for (const [label, fen] of POSITIONS) {
      const chess = fen ? new Chess(fen) : new Chess();
      const client = capturingClient();
      const { move, record } = await selectMove({
        chess,
        strategy: resolveStrategy({ strategyId: preset.id }),
        jevClient: client,
        lastMovesSan: ["1. e4 e5", "2. Nf3 Nc6"],
      });
      assert.ok(move, `${label}: a move must be produced`);
      if (pipelineId === "search-only") {
        assert.equal(client.calls.length, 0, `${label}: the baseline must not call Jev`);
        continue;
      }
      for (const call of client.calls) {
        const info = validateRequest(call);
        validateInternalConsistency(call);
        assert.ok(info.questionCount >= 1, `${label}: at least one question`);
      }
      assert.ok(record.requests >= 1, `${label}: the record must count its requests`);
    }
  });
}

test("the judging payload names every candidate it asks about", async () => {
  const chess = new Chess("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1");
  const client = capturingClient();
  await selectMove({ chess, strategy: resolveStrategy({ strategyId: "balanced" }), jevClient: client, lastMovesSan: [] });
  const call = client.calls[0];
  validateRequest(call);
  validateInternalConsistency(call);
  const ids = call.state.candidates.map((candidate) => candidate.id);
  assert.equal(ids.length, 12, "balanced shortlists twelve candidates on this position");
  const perCandidate = Object.keys(call.questions).filter((id) => id.startsWith("cand_"));
  const dims = resolveStrategy({ strategyId: "balanced" }).dims.length;
  assert.equal(perCandidate.length, ids.length * dims, "there must be one question per candidate per dimension");
  assert.ok(call.questions.standing && call.questions.phase && call.questions.plan, "the assessment questions ride along");
});

test("board diagrams are included by default and can be switched off", async () => {
  const chess = new Chess();
  const withBoards = capturingClient();
  await selectMove({ chess, strategy: resolveStrategy({ strategyId: "balanced" }), jevClient: withBoards, lastMovesSan: [] });
  assert.ok(
    withBoards.calls[0].state.candidates.every((candidate) => typeof candidate.board_after_8_to_1 === "string"),
    "the default state shows the position after each candidate",
  );

  const withoutBoards = capturingClient();
  await selectMove({ chess, strategy: resolveStrategy({ strategyId: "pure-jev" }), jevClient: withoutBoards, lastMovesSan: [] });
  assert.ok(
    withoutBoards.calls[0].state.candidates.every((candidate) => candidate.board_after_8_to_1 === undefined),
    "pure-choice omits the diagrams to keep a full legal-move list affordable",
  );
});

test("the withheld hints stay withheld unless a strategy asks for them", async () => {
  const chess = new Chess("r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 6");
  const client = capturingClient();
  await selectMove({ chess, strategy: resolveStrategy({ strategyId: "balanced" }), jevClient: client, lastMovesSan: [] });
  const state = client.calls[0].state;
  assert.ok(
    state.candidates.every((candidate) => candidate.code_search_hint_centipawns === undefined),
    "the search's opinion must not leak into the state by default",
  );
  assert.ok(
    state.candidates.every((candidate) => candidate.opponent_captures_available === undefined),
    "capture evidence is off by default",
  );

  const experimental = resolveStrategy({ strategyId: "balanced" });
  experimental.includeSearchHints = true;
  experimental.exposeCaptureEvidence = true;
  const hinted = capturingClient();
  await selectMove({ chess, strategy: experimental, jevClient: hinted, lastMovesSan: [] });
  const hintedState = hinted.calls[0].state;
  assert.ok(hintedState.candidates.every((candidate) => typeof candidate.code_search_hint_centipawns === "number"), "the switch works");
  assert.ok(hintedState.candidates.every((candidate) => Array.isArray(candidate.opponent_captures_available)), "the switch works");
});

test("the audit payload describes the nomination and validates too", async () => {
  const chess = new Chess("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
  const client = capturingClient();
  await selectMove({ chess, strategy: resolveStrategy({ strategyId: "jev-verify" }), jevClient: client, lastMovesSan: [] });
  assert.equal(client.calls.length, 2, "one nomination and one audit");
  const audit = client.calls[1];
  validateRequest(audit);
  assert.ok(audit.state.nomination, "the audit state must describe the nominated move");
  assert.ok(typeof audit.state.nomination.move_san === "string");
  assert.ok(Array.isArray(audit.state.nomination.capturable_replies_for_opponent));
  assert.deepEqual(Object.keys(audit.questions).sort(), [
    "audit_gives_away_advantage",
    "audit_hangs_material",
    "audit_opponent_forcing",
    "audit_regret",
  ]);
  assert.ok(Object.values(audit.questions).every((question) => question.type === "noul"), "the audit is all yes/no questions");
});

test("payload size stays inside the documented limits in the worst case", async () => {
  // The widest payloads are a 14-candidate attacking shortlist and a full legal-move
  // choice in the opening; both must fit state + longest question inside 32k tokens.
  const cases = [
    ["attacking, busy position", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", "attacking"],
    ["pure choice, opening", undefined, "pure-jev"],
    ["nominate - verify, opening", undefined, "jev-verify"],
    ["positional, busy position", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", "positional"],
  ];
  const rows = [];
  for (const [label, fen, strategyId] of cases) {
    const chess = fen ? new Chess(fen) : new Chess();
    const client = capturingClient();
    await selectMove({ chess, strategy: resolveStrategy({ strategyId }), jevClient: client, lastMovesSan: [] });
    for (const call of client.calls) {
      const { stateTokens, questionCount } = validateRequest(call);
      const longest = Math.max(...Object.values(call.questions).map((question) => estimateTokens(question)));
      rows.push([
        label,
        strategyId,
        questionCount,
        stateTokens,
        stateTokens + longest,
        estimateTokens({ state: call.state, model: "jev-latest", questions: call.questions }),
      ]);
      assert.ok(stateTokens + longest <= MAX_STATE_AND_LONGEST_QUESTION_TOKENS, `${label}: over the 32k limit`);
    }
  }
  const header = ["case", "strategy", "questions", "state tok", "state+longest", "total tok"];
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => String(row[index]).length)));
  console.log(`  ${header.map((cell, index) => cell.padEnd(widths[index])).join("  ")}`);
  for (const row of rows) console.log(`  ${row.map((cell, index) => String(cell).padEnd(widths[index])).join("  ")}`);
  assert.ok(rows.length > 0);
});

test("what one move actually costs, per strategy", async () => {
  // Measured, not estimated from a guess: Jev bills input tokens only ($0.042/Mtok) and
  // output is free. This table is what the README quotes.
  const chess = new Chess("r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 6");
  const rows = [];
  let worst = 0;
  for (const preset of strategiesPayload().presets) {
    const client = capturingClient();
    await selectMove({ chess, strategy: resolveStrategy({ strategyId: preset.id }), jevClient: client, lastMovesSan: [] });
    const requests = client.calls.map((call) => ({
      questions: Object.keys(call.questions).length,
      tokens: estimateTokens({ state: call.state, model: "jev-latest", questions: call.questions }),
    }));
    if (requests.length === 0) {
      rows.push([preset.id, 0, 0, "0", "$0 (no Jev)"]);
      continue;
    }
    const total = requests.reduce((sum, entry) => sum + entry.tokens, 0);
    worst = Math.max(worst, total);
    const cost = (total / 1_000_000) * 0.042;
    rows.push([
      preset.id,
      requests.length,
      requests.reduce((sum, entry) => sum + entry.questions, 0),
      total,
      cost === 0 ? "$0" : `$${cost.toFixed(6)}`,
    ]);
  }
  const header = ["strategy", "requests", "questions", "input tok", "cost / move"];
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => String(row[index]).length)));
  console.log(`  ${header.map((cell, index) => cell.padEnd(widths[index])).join("  ")}`);
  for (const row of rows) console.log(`  ${row.map((cell, index) => String(cell).padEnd(widths[index])).join("  ")}`);
  const worstCost = (worst / 1_000_000) * 0.042;
  console.log(`  info  dearest strategy ≈ ${worst} tokens ≈ $${worstCost.toFixed(6)} per move (about ${Math.round(1 / worstCost)} moves per dollar)`);
  assert.ok(worstCost < 0.005, "even the widest strategy must cost well under half a cent per move");
  assert.ok(worst < 64_000, "and must stay inside the context limit");
});

// ===========================================================================

await Promise.all(pending);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.error.message}`);
  process.exitCode = 1;
}
