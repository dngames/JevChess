/**
 * A zero-dependency Gemini client for the strategy layer.
 *
 * Facts this file is built on, read from the live docs on 2026-09-19 (see README for the
 * sources). Several of them are traps worth restating, because each one cost a research pass:
 *
 *  - The **Interactions API** (`POST /v1/interactions`) is the recommended path for new
 *    projects; the classic `generateContent` is "considered legacy" but *fully supported*, with
 *    no sunset date. The docs disagree with themselves about the version prefix (`/v1`,
 *    `/v1beta`, `/v1beta2`) and about the response shape (text moved from `outputs[-1].text` to
 *    `steps[i].content[j].text` in June 2026). So: both paths are implemented, the response is
 *    parsed defensively, and which one ran is recorded.
 *  - Auth is the `x-goog-api-key` header. `?key=` still works but is no longer documented.
 *  - `thinking_level` is `minimal|low|medium|high`, and **`gemini-3.8-flash` rejects `minimal`**
 *    (it errors). Thought tokens are billed as output tokens, so the level is a cost control the
 *    caller chooses per review, not a constant.
 *  - The Interactions API documents **no `temperature`**, so none is sent.
 *  - Errors come back as `{error: {code, message}}` with snake_case codes on the Interactions
 *    path, while other doc pages still speak gRPC (`RESOURCE_EXHAUSTED`). Both are handled.
 *  - There is **no documented `Retry-After`**, so backoff is ours (and a header is honoured if
 *    one happens to appear).
 *
 * The API key never enters a URL, a log line or an error message.
 */

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

/** Model ids verified present in the docs on 2026-09-19. `lite` is cheaper, `flash` smarter. */
export const GEMINI_MODELS = {
  "gemini-3.8-flash": { in: 0.75, out: 3.75, thinking: "medium", stable: true, note: "recommended reasoning default" },
  "gemini-3.7-flash": { in: 0.75, out: 3.75, thinking: "medium", stable: true },
  "gemini-3.6-flash": { in: 0.75, out: 3.75, thinking: "medium", stable: true },
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5, thinking: "minimal", stable: true, note: "cheapest stable text model" },
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.5, thinking: "minimal", stable: true },
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4, thinking: "off", stable: true, note: "cheapest, previous generation" },
  "gemini-3.1-pro-preview": { in: 2.0, out: 12.0, thinking: "high", stable: false, note: "preview, no free tier" },
};

/**
 * The default is the lite model, not the flagship, for a blunt practical reason: the Gemini free
 * tier allows **20 requests per day** for `gemini-3.8-flash`, which a single Jev-vs-Jev game can
 * exhaust, while `gemini-3.5-flash-lite` plans just as sensibly at half the cost and half the
 * latency ($0.00067 vs $0.00131 per review, 3.8 s vs 7.5 s measured) and still had quota. Set
 * `GEMINI_MODEL=gemini-3.8-flash` when you have the quota and want the better plans.
 */
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"];

/** Models that error on `minimal`, per the 3.8 Flash model page. */
const REJECTS_MINIMAL = /^gemini-3\.(7|8)-flash/;

export class GeminiError extends Error {
  constructor(message, { code, status, retryable = false } = {}) {
    super(message);
    this.name = "GeminiError";
    this.code = code ?? "gemini_error";
    this.status = status ?? null;
    this.retryable = Boolean(retryable);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new GeminiError("request cancelled", { code: "cancelled" }));
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new GeminiError("request cancelled", { code: "cancelled" }));
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt, base = 1000, cap = 30_000) {
  return Math.round(Math.min(cap, base * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5));
}

/** Colour in a real thinking level for a model, reporting when the choice had to move. */
export function resolveThinkingLevel(model, requested) {
  const wanted = THINKING_LEVELS.includes(requested) ? requested : GEMINI_MODELS[model]?.thinking ?? "medium";
  if (wanted === "minimal" && REJECTS_MINIMAL.test(model)) {
    return { level: "low", note: `${model} rejects thinking_level "minimal"; used "low"` };
  }
  return { level: wanted, note: null };
}

/** Price of a response in USD, from the documented table. */
export function estimateCost(model, usage) {
  const price = GEMINI_MODELS[model];
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  if (!price) return null;
  return (input / 1_000_000) * price.in + (output / 1_000_000) * price.out;
}

export class GeminiClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.model]
   * @param {"interactions"|"generateContent"} [options.api]
   * @param {string} [options.baseUrl]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxAttempts]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {(entry: object) => void} [options.onLog]
   */
  constructor({
    apiKey,
    model = DEFAULT_MODEL,
    api = "interactions",
    baseUrl = GEMINI_BASE_URL,
    timeoutMs = 60_000,
    maxAttempts = 3,
    fetchImpl = globalThis.fetch,
    onLog = null,
  } = {}) {
    if (!apiKey || typeof apiKey !== "string") throw new GeminiError("No Gemini API key configured.", { code: "no-api-key" });
    if (typeof fetchImpl !== "function") throw new GeminiError("global fetch is unavailable; Node 20+ is required.", { code: "no-fetch" });
    this.apiKey = apiKey;
    this.model = model;
    this.api = api === "generateContent" ? "generateContent" : "interactions";
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.maxAttempts = Math.max(1, maxAttempts);
    this.fetchImpl = fetchImpl;
    this.onLog = onLog;
    this.mock = false;
    this.provider = "gemini";
    this.stats = { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsd: 0 };
  }

  /** The request this client would send — exposed so tests can assert the wire shape. */
  buildRequest({ input, systemInstruction, schema, thinkingLevel, maxOutputTokens = 2048 } = {}) {
    if (this.api === "interactions") {
      const body = {
        model: this.model,
        input,
        system_instruction: systemInstruction,
        response_format: { type: "text", mime_type: "application/json", schema },
        generation_config: { max_output_tokens: maxOutputTokens },
      };
      if (thinkingLevel && thinkingLevel !== "off") body.generation_config.thinking_level = thinkingLevel;
      return {
        url: `${this.baseUrl}/v1/interactions`,
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body,
      };
    }

    const generationConfig = { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens };
    if (thinkingLevel && thinkingLevel !== "off") generationConfig.thinkingConfig = { thinkingLevel: String(thinkingLevel).toUpperCase() };
    return {
      url: `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ parts: [{ text: input }] }],
        generationConfig,
      },
    };
  }

  /**
   * Ask for one schema-shaped JSON answer.
   * @returns {Promise<{ok: true, json: unknown, text: string, usage: object, model: string, api: string,
   *   attempts: number, elapsedMs: number, thinkingLevel: string, notes: string[]}
   *   | {ok: false, error: string, code: string, attempts: number, elapsedMs: number, notes: string[]}>}
   */
  async generateJson({ input, systemInstruction, schema, thinkingLevel = null, maxOutputTokens = 2048, signal = null } = {}) {
    const startedAt = Date.now();
    const notes = [];
    const resolved = resolveThinkingLevel(this.model, thinkingLevel);
    if (resolved.note) notes.push(resolved.note);

    // A signal that is already aborted never fires again, so check it explicitly — otherwise an
    // aborted caller sails into a request and the failure surfaces as a confusing shape error.
    // (The Jev client had exactly this bug; the same test caught it in both places.)
    if (signal?.aborted) {
      return { ok: false, error: "request cancelled", code: "cancelled", attempts: 0, elapsedMs: 0, notes };
    }

    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const request = this.buildRequest({ input, systemInstruction, schema, thinkingLevel: resolved.level, maxOutputTokens });
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        this.stats.requests += 1;
        const response = await this.fetchImpl(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const raw = await response.text().catch(() => "");
          const parsed = safeJson(raw);
          const code = parsed?.error?.code ?? parsed?.error?.status ?? `http_${response.status}`;
          const message = parsed?.error?.message ?? raw.slice(0, 200);
          const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
          lastError = new GeminiError(humanize(response.status, code, message), {
            code: errorCode(response.status, code),
            status: response.status,
            retryable,
          });
          this.stats.failures += 1;
          // Tell the caller's log, or a failure is invisible from the server side: the first
          // version of this never emitted anything, so a rate-limited run looked like silence.
          this.#log({ event: "gemini-error", attempt, status: response.status, code: lastError.code, message: lastError.message });
          if (!retryable || attempt === this.maxAttempts) {
            return { ok: false, error: lastError.message, code: lastError.code, attempts: attempt, elapsedMs: Date.now() - startedAt, notes };
          }
          const retryAfter = Number(response.headers?.get?.("retry-after"));
          await sleep(Number.isFinite(retryAfter) ? Math.min(30_000, retryAfter * 1000) : backoffMs(attempt), signal);
          continue;
        }

        const payload = await response.json();
        const parsed = this.extract(payload);
        if (!parsed.ok) {
          // A well-formed HTTP response that carried no usable answer: no point retrying.
          return { ok: false, error: parsed.error, code: parsed.code, attempts: attempt, elapsedMs: Date.now() - startedAt, notes };
        }
        const usage = parsed.usage;
        this.stats.inputTokens += usage.inputTokens;
        this.stats.outputTokens += usage.outputTokens;
        this.stats.thoughtTokens += usage.thoughtTokens;
        const cost = estimateCost(this.model, usage);
        if (cost !== null) this.stats.costUsd += cost;
        if (parsed.notes) notes.push(...parsed.notes);

        this.#log({ event: "gemini-response", api: this.api, attempt, usage, thinkingLevel: resolved.level });
        return {
          ok: true,
          json: parsed.json,
          text: parsed.text,
          usage,
          costUsd: cost,
          model: payload.model ?? this.model,
          api: this.api,
          attempts: attempt,
          elapsedMs: Date.now() - startedAt,
          thinkingLevel: resolved.level,
          notes,
        };
      } catch (error) {
        const aborted = error?.name === "AbortError" || error?.code === "cancelled";
        lastError = new GeminiError(
          aborted ? `Gemini did not answer within ${Math.round(this.timeoutMs / 1000)}s.` : `Could not reach Gemini: ${error?.message ?? "network error"}`,
          { code: aborted ? "timeout" : "network", retryable: true },
        );
        this.stats.failures += 1;
        if (signal?.aborted) return { ok: false, error: "request cancelled", code: "cancelled", attempts: attempt, elapsedMs: Date.now() - startedAt, notes };
        if (attempt === this.maxAttempts) {
          return { ok: false, error: lastError.message, code: lastError.code, attempts: attempt, elapsedMs: Date.now() - startedAt, notes };
        }
        await sleep(backoffMs(attempt), signal);
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    }

    return { ok: false, error: lastError?.message ?? "Gemini request failed.", code: lastError?.code ?? "gemini_error", attempts: this.maxAttempts, elapsedMs: Date.now() - startedAt, notes };
  }

  /**
   * Pull the answer out of either response shape. Kept separate so it can be tested directly
   * against real payloads for both APIs.
   */
  extract(payload) {
    if (!payload || typeof payload !== "object") return { ok: false, error: "Gemini returned an empty body.", code: "empty" };

    // Interactions API: a timeline of steps; the answer is the model_output step(s).
    if (Array.isArray(payload.steps)) {
      const notes = [];
      const status = payload.status ?? "completed";
      if (status === "failed") {
        const detail = Array.isArray(payload.errors) ? payload.errors.map((entry) => entry?.message ?? entry).join("; ") : "";
        return { ok: false, error: `Gemini reported a failed interaction${detail ? `: ${detail}` : ""}`, code: "interaction_failed" };
      }
      if (status === "incomplete") notes.push("the interaction was incomplete (likely max_output_tokens) — the JSON may be truncated");
      const text = payload.steps
        .filter((step) => step?.type === "model_output")
        .flatMap((step) => (Array.isArray(step.content) ? step.content : []))
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      const usage = payload.usage ?? {};
      const usageOut = {
        inputTokens: usage.total_input_tokens ?? 0,
        outputTokens: usage.total_output_tokens ?? 0,
        thoughtTokens: usage.total_thought_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      };
      if (text.trim().length === 0) return { ok: false, error: "Gemini returned no text output.", code: "no_text" };
      const json = safeJson(text);
      if (json === null) return { ok: false, error: "Gemini's output was not valid JSON.", code: "bad_json", notes };
      return { ok: true, text, json, usage: usageOut, notes };
    }

    // Classic generateContent: candidates[].content.parts[].text
    if (Array.isArray(payload.candidates)) {
      const notes = [];
      const blocked = payload.promptFeedback?.blockReason;
      if (blocked) return { ok: false, error: `Gemini blocked the request (${blocked}).`, code: "blocked" };
      const candidate = payload.candidates[0];
      if (!candidate) return { ok: false, error: "Gemini returned no candidates.", code: "no_candidates" };
      if (candidate.finishReason && !["STOP", "MAX_TOKENS"].includes(candidate.finishReason)) {
        notes.push(`finishReason=${candidate.finishReason}`);
      }
      if (candidate.finishReason === "MAX_TOKENS") notes.push("hit max_output_tokens; the JSON may be truncated");
      const text = (candidate.content?.parts ?? [])
        .filter((part) => typeof part?.text === "string")
        .map((part) => part.text)
        .join("");
      const metadata = payload.usageMetadata ?? {};
      const usageOut = {
        inputTokens: metadata.promptTokenCount ?? 0,
        outputTokens: metadata.candidatesTokenCount ?? 0,
        thoughtTokens: metadata.thoughtsTokenCount ?? 0,
        totalTokens: metadata.totalTokenCount ?? 0,
      };
      if (text.trim().length === 0) return { ok: false, error: "Gemini returned no text output.", code: "no_text" };
      const json = safeJson(text);
      if (json === null) return { ok: false, error: "Gemini's output was not valid JSON.", code: "bad_json", notes };
      return { ok: true, text, json, usage: usageOut, notes };
    }

    return { ok: false, error: "Unrecognised Gemini response shape.", code: "unknown_shape" };
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

/**
 * A deterministic stand-in, so the whole strategy layer can be built and tested with no key.
 * The plan is derived from a hash of the prompt, which makes it stable per position and
 * different across positions — enough to exercise caching, routing and the record, and
 * plainly labelled so no measurement can mistake it for a real plan.
 */
export class MockLlmClient {
  constructor({ model = "mock-strategist", onLog = null } = {}) {
    this.model = model;
    this.api = "mock";
    this.mock = true;
    this.provider = "mock";
    this.stats = { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsd: 0 };
    this.onLog = onLog;
  }

  async generateJson({ input, thinkingLevel = "low" } = {}) {
    const startedAt = Date.now();
    this.stats.requests += 1;
    const seed = hash32(String(input ?? ""));
    const kinds = ["improve_pieces", "attack_king", "pawn_break", "minority_attack", "trade_to_endgame", "restrain", "activate_king", "defend_hold"];
    const files = "abcdefgh";
    // Unsigned shifts throughout: `hash32` returns a value up to 2^32-1, and `>>` is signed, which
    // turned "3 + (seed >> 12) % 6" negative and clamped every mock plan to a one-ply review.
    const plan = kinds[seed % kinds.length];
    const target = `${files[(seed >>> 3) % 8]}${2 + ((seed >>> 6) % 6)}`;
    const json = {
      plan,
      targets: seed % 3 === 0 ? [] : [target],
      risk: ["hold", "balanced", "complicate"][(seed >>> 9) % 3],
      review_after_plies: 3 + ((seed >>> 12) % 6),
      weight_deltas: seed % 2 === 0 ? { activity: 0.05 } : {},
      ask_jev: [],
      opponent_plan: kinds[(seed >>> 15) % kinds.length],
      commentary: `Mock strategist output for position hash ${seed.toString(16).slice(0, 6)} — not real chess judgement.`,
    };
    const inputTokens = Math.ceil(String(input ?? "").length / 4);
    this.stats.inputTokens += inputTokens;
    const usage = { inputTokens, outputTokens: 60, thoughtTokens: 0, totalTokens: inputTokens + 60 };
    if (this.onLog) this.onLog({ event: "gemini-mock-response", plan });
    return {
      ok: true,
      json,
      text: JSON.stringify(json),
      usage,
      costUsd: 0,
      model: this.model,
      api: "mock",
      attempts: 1,
      elapsedMs: Date.now() - startedAt,
      thinkingLevel,
      notes: ["mock provider: this plan says nothing about chess"],
    };
  }
}

/** Real client when a key exists, mock otherwise. `forceMock` wins over a key. */
export function createLlmClient({ apiKey, forceMock = false, ...rest } = {}) {
  if (forceMock || !apiKey) return new MockLlmClient(rest);
  return new GeminiClient({ apiKey, ...rest });
}

// ---------------------------------------------------------------------------

function humanize(status, code, message) {
  const detail = message ? ` ${String(message).slice(0, 200)}` : "";
  if (status === 401 || status === 403 || code === "authentication" || code === "permission_denied") {
    return `Gemini rejected the API key (HTTP ${status}).${detail} Check GEMINI_API_KEY, and note that keys created before the auth-key change may need replacing.`;
  }
  if (status === 400) return `Gemini rejected the request as malformed (HTTP 400).${detail}`;
  if (status === 404 || code === "model_not_found") return `Gemini does not know that model (HTTP ${status}).${detail}`;
  if (status === 429) return `Gemini rate limit or quota reached (HTTP 429).${detail}`;
  if (status === 503) return `Gemini is overloaded (HTTP 503).${detail}`;
  return `Gemini returned HTTP ${status}.${detail}`;
}

function errorCode(status, code) {
  const text = String(code ?? "").toUpperCase();
  if (status === 401 || status === 403 || text === "AUTHENTICATION" || text === "PERMISSION_DENIED") return "gemini-auth";
  if (status === 404 || text === "MODEL_NOT_FOUND") return "gemini-model";
  if (status === 429 || text === "RESOURCE_EXHAUSTED" || text === "RATE_LIMIT_EXCEEDED" || text === "QUOTA_EXCEEDED") return "gemini-rate-limit";
  if (status === 400 || text === "INVALID_ARGUMENT" || text === "INVALID_REQUEST" || text === "PARAMETER_UNKNOWN") return "gemini-bad-request";
  if (status >= 500 || text === "UNAVAILABLE") return "gemini-overloaded";
  return "gemini-error";
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
