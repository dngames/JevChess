/**
 * TypeSafe / Jev HTTP client.
 *
 * Jev is a System One model: it answers typed questions about a state and returns
 * typed values (choice + probabilities, score + probabilities, noul 0..1). It never
 * generates prose, so nothing here expects text back.
 *
 * Zero dependencies: global fetch (Node >= 20), AbortController for timeouts.
 *
 * The API key is read from the environment by the caller and never logged, never
 * returned to the browser, and never included in an error message.
 */

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const ENDPOINT_PATH = "/v1/systemone";

/** Error carrying enough structure for the caller to decide whether to give up. */
export class TypeSafeError extends Error {
  constructor(message, { code, status, retryable = false, body } = {}) {
    super(message);
    this.name = "TypeSafeError";
    this.code = code ?? "jev-error";
    this.status = status ?? null;
    this.retryable = retryable;
    this.body = body ?? null;
  }
}

// ---------------------------------------------------------------------------
// Question builders. Each question is a plain object; the SDK-style helpers just
// keep the call sites readable and the shapes honest.
// ---------------------------------------------------------------------------

/** Choose one option from a fixed set. `criteria` maps option -> description (or null). */
export function choice(instructions, criteria) {
  return { type: "choice", instructions, criteria };
}

/** Rate the state on ordered levels (2..10, low to high). */
export function score(instructions, criteria) {
  if (!Array.isArray(criteria) || criteria.length < 2) {
    throw new Error("score() needs at least two levels");
  }
  return { type: "score", instructions, criteria };
}

/** Yes/no judgement, returned as a probability in 0..1. */
export function noul(instructions, criteria) {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

export const questions = { choice, score, noul };

// ---------------------------------------------------------------------------
// Real client
// ---------------------------------------------------------------------------

export class TypeSafeClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey            bearer token (server-side only)
   * @param {string} [opts.model]           model id or alias
   * @param {string} [opts.baseUrl]
   * @param {number} [opts.timeoutMs]       per-attempt timeout
   * @param {number} [opts.maxAttempts]     attempts including the first
   * @param {number} [opts.maxStateTokens]  soft guard: refuse absurd states before sending
   * @param {typeof fetch} [opts.fetchImpl] injectable for tests
   */
  constructor({
    apiKey,
    model = DEFAULT_MODEL,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = 45_000,
    maxAttempts = 4,
    maxStateTokens = 30_000,
    fetchImpl = globalThis.fetch,
    onLog = null,
  } = {}) {
    if (!apiKey || typeof apiKey !== "string") {
      throw new TypeSafeError("No TypeSafe API key configured.", { code: "no-api-key" });
    }
    if (typeof fetchImpl !== "function") {
      throw new TypeSafeError("global fetch is unavailable; Node 20+ is required.", { code: "no-fetch" });
    }
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.maxAttempts = Math.max(1, maxAttempts);
    this.maxStateTokens = maxStateTokens;
    this.fetchImpl = fetchImpl;
    this.onLog = onLog;
    this.mock = false;
    this.stats = { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 };
  }

  /** Rough token guard. Jev's budget is 32k for state + longest question; ~4 chars/token. */
  estimateTokens(payload) {
    return Math.ceil(JSON.stringify(payload).length / 4);
  }

  /**
   * Evaluate a state against a map of typed questions.
   * @returns {Promise<{model: string, answers: Record<string, object>, usage: object, attempts: number, elapsedMs: number}>}
   */
  async systemOne({ state, questions: questionMap, model = this.model, signal = null } = {}) {
    if (!questionMap || Object.keys(questionMap).length === 0) {
      return { model, answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, attempts: 0, elapsedMs: 0 };
    }
    const body = { state, model, questions: questionMap };
    const estimated = this.estimateTokens(body);
    if (estimated > this.maxStateTokens) {
      throw new TypeSafeError(
        `Request is about ${estimated} tokens, over the ${this.maxStateTokens}-token guard. ` +
          "Send fewer candidates per question set.",
        { code: "state-too-large" },
      );
    }

    const startedAt = Date.now();
    let lastError = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        this.stats.requests += 1;
        const response = await this.fetchImpl(`${this.baseUrl}${ENDPOINT_PATH}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.ok) {
          const json = await response.json();
          const usage = json.usage ?? { input_tokens: 0, output_tokens: 0 };
          this.stats.inputTokens += usage.input_tokens ?? 0;
          this.stats.outputTokens += usage.output_tokens ?? 0;
          const result = {
            model: json.model ?? model,
            answers: json.answers ?? {},
            usage,
            attempts: attempt,
            elapsedMs: Date.now() - startedAt,
          };
          this.#log({ event: "jev-response", attempt, usage, elapsedMs: result.elapsedMs, questions: Object.keys(questionMap).length });
          return result;
        }

        const raw = await response.text().catch(() => "");
        const parsed = safeJson(raw);
        const message = parsed?.detail?.message ?? parsed?.error?.message ?? raw.slice(0, 300) ?? "";
        const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
        lastError = new TypeSafeError(
          humanizeHttpError(response.status, message),
          { code: errorCodeForStatus(response.status), status: response.status, retryable, body: parsed ?? raw },
        );
        this.stats.failures += 1;
        this.#log({ event: "jev-error", attempt, status: response.status, code: lastError.code });

        if (!retryable || attempt === this.maxAttempts) throw lastError;

        const retryAfter = parseRetryAfter(response.headers?.get?.("retry-after"));
        await sleep(retryAfter ?? backoffMs(attempt), signal);
      } catch (error) {
        if (error instanceof TypeSafeError) {
          if (!error.retryable || attempt === this.maxAttempts) throw error;
          lastError = error;
          continue;
        }
        const aborted = error?.name === "AbortError";
        if (signal?.aborted) {
          throw new TypeSafeError("Jev request cancelled.", { code: "cancelled", retryable: false });
        }
        lastError = new TypeSafeError(
          aborted
            ? `Jev did not answer within ${Math.round(this.timeoutMs / 1000)}s.`
            : `Could not reach Jev: ${error?.message ?? "network error"}`,
          { code: aborted ? "timeout" : "network", retryable: true },
        );
        this.stats.failures += 1;
        this.#log({ event: "jev-error", attempt, code: lastError.code, message: lastError.message });
        if (attempt === this.maxAttempts) throw lastError;
        await sleep(backoffMs(attempt), signal);
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    }

    throw lastError ?? new TypeSafeError("Jev request failed.", { code: "jev-error" });
  }

  #log(entry) {
    if (this.onLog) {
      try {
        this.onLog(entry);
      } catch {
        /* logging must never break a game */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mock provider — lets the whole app be exercised (and unit-tested) with no key.
// Deterministic: answers are a hash of the question id, its type and the state, so
// the same position always produces the same "judgement" and tests can assert on it.
// ---------------------------------------------------------------------------

export class MockTypeSafeClient {
  constructor({ model = "mock-jev", onLog = null } = {}) {
    this.apiKey = null;
    this.model = model;
    this.mock = true;
    this.onLog = onLog;
    this.stats = { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 };
  }

  async systemOne({ state, questions: questionMap = {}, model = this.model } = {}) {
    const startedAt = Date.now();
    this.stats.requests += 1;
    const stateKey = hash32(JSON.stringify(state ?? ""));
    const answers = {};
    for (const [id, question] of Object.entries(questionMap)) {
      const seed = (hash32(id) ^ stateKey) >>> 0;
      const rand = mulberry32(seed);
      if (question.type === "choice") {
        const options = Object.keys(question.criteria ?? {});
        const probabilities = {};
        let total = 0;
        for (const option of options) {
          const weight = 0.15 + rand();
          probabilities[option] = weight;
          total += weight;
        }
        let best = options[0] ?? null;
        for (const option of options) {
          probabilities[option] = round4(probabilities[option] / total);
          if (probabilities[option] > (probabilities[best] ?? -1)) best = option;
        }
        answers[id] = {
          type: "choice",
          choice: best,
          probabilities,
          confidence: round4(probabilities[best] ?? 0),
        };
      } else if (question.type === "score") {
        const levels = (question.criteria ?? []).length;
        const at = levels > 1 ? Math.floor(rand() * levels) : 0;
        const probabilities = {};
        for (let i = 0; i < levels; i += 1) probabilities[String(i)] = i === at ? 0.85 : round4(0.15 / Math.max(1, levels - 1));
        answers[id] = {
          type: "score",
          score: at,
          probabilities,
          confidence: 0.85,
          legend: Object.fromEntries((question.criteria ?? []).map((level, i) => [String(i), level])),
        };
      } else {
        answers[id] = { type: "noul", noul: round4(0.05 + rand() * 0.9) };
      }
    }
    const inputTokens = Math.ceil(JSON.stringify(state ?? "").length / 4) + Object.keys(questionMap).length * 24;
    this.stats.inputTokens += inputTokens;
    const result = {
      model,
      answers,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
      attempts: 1,
      elapsedMs: Date.now() - startedAt,
      mock: true,
    };
    if (this.onLog) this.onLog({ event: "jev-mock-response", questions: Object.keys(questionMap).length });
    return result;
  }
}

/**
 * Pick the real client when a key exists, otherwise the mock one. `JEV_MOCK=1`
 * forces mock mode even when a key is present (handy for offline UI work).
 */
export function createJevClient({ apiKey, forceMock = false, ...rest } = {}) {
  if (forceMock || !apiKey) return new MockTypeSafeClient(rest);
  return new TypeSafeClient({ apiKey, ...rest });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function humanizeHttpError(status, message) {
  const detail = message ? ` ${message}` : "";
  switch (status) {
    case 401:
    case 403:
      return `Jev rejected the API key (HTTP ${status}).${detail} Check TYPESAFE_API_KEY in .env.`;
    case 422:
      return `Jev rejected the request as malformed (HTTP 422).${detail}`;
    case 429:
      return `Jev rate limit hit (HTTP 429).${detail}`;
    case 529:
      return `Jev is overloaded (HTTP 529).${detail}`;
    default:
      return status >= 500
        ? `Jev returned HTTP ${status}.${detail}`
        : `Jev returned HTTP ${status}.${detail}`;
  }
}

function errorCodeForStatus(status) {
  if (status === 401 || status === 403) return "jev-auth";
  if (status === 422) return "jev-bad-request";
  if (status === 429) return "jev-rate-limit";
  if (status === 529) return "jev-overloaded";
  return "jev-error";
}

export function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  return null;
}

export function backoffMs(attempt, base = 400, cap = 8_000) {
  const exponential = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TypeSafeError("Jev request cancelled.", { code: "cancelled" }));
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new TypeSafeError("Jev request cancelled.", { code: "cancelled" }));
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function hash32(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}
