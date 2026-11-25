// Zero-dependency OpenRouter chat client used by the System-1 supervisor and the MEMORY.md
// consolidator. It is deliberately small: one POST to /chat/completions, a bounded timeout,
// safe JSON extraction, and strict secret hygiene. It never logs or embeds the API key in errors.

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_BODY_CHARS = 500;
const MAX_ERROR_NAME_CHARS = 60;

/**
 * Rebuilds an upstream error into a sanitized stand-in.
 *
 * `Error.cause` is exactly where a raw `fetch` failure lands, and Node's network errors can embed
 * the whole request — including `authorization: Bearer <key>` — in their message, `code` or stack.
 * A newly constructed Error carries only the redacted message, so neither the original object, its
 * stack, nor any `request`/`config` property it referenced can ever be reached through the cause
 * chain. Redaction is applied twice (to the message/name/code here, and again by `redactSecrets`).
 */
export function sanitizeErrorCause(cause, secret) {
  if (cause === null || cause === undefined) return undefined;
  const raw = cause instanceof Error ? cause : new Error(String(cause));
  const message = redactSecrets(raw.message || raw.name || "upstream error", secret);
  const safe = new Error(message);
  const name = redactSecrets(typeof raw.name === "string" && raw.name ? raw.name : "Error", secret)
    .slice(0, MAX_ERROR_NAME_CHARS);
  safe.name = name || "Error";
  if (raw.code !== undefined && raw.code !== null) {
    safe.code = redactSecrets(String(raw.code), secret);
  }
  return safe;
}

export class OpenRouterError extends Error {
  constructor(message, { code = "openrouter_error", status = null, cause = undefined } = {}) {
    // Never forward the caller's cause object: it may be a raw fetch error that still holds the key.
    const safeCause = sanitizeErrorCause(cause);
    super(message, safeCause ? { cause: safeCause } : undefined);
    this.name = "OpenRouterError";
    this.code = code;
    this.status = status;
    if (safeCause) this.cause = safeCause;
  }
}

export class InvalidJsonError extends OpenRouterError {
  constructor(message, options = {}) {
    super(message, { code: "invalid_json", ...options });
    this.name = "InvalidJsonError";
  }
}

/**
 * Removes every occurrence of the given secret from a string. Also strips a leading
 * `Bearer <secret>`/`Basic <secret>` fragment so auth headers can never leak through
 * an upstream error body or a thrown fetch error.
 */
export function redactSecrets(value, secret) {
  let text = typeof value === "string" ? value : String(value ?? "");
  if (typeof secret === "string" && secret.length > 0) {
    text = text.split(secret).join("[REDACTED]");
    // Guard against URL-encoded / base64 forms of very common accidental leaks.
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) text = text.split(encoded).join("[REDACTED]");
  }
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]");
  return text;
}

/**
 * Extracts a JSON object from model output. Handles plain JSON, fenced JSON
 * (``` or ```json), fences with a trailing newline, and prose around a single object.
 * The balanced-brace scan is string-aware, so braces inside string literals are safe.
 */
export function extractJsonObject(text) {
  if (typeof text !== "string") {
    throw new InvalidJsonError("Model response was not text");
  }

  let source = text.replace(/^\uFEFF/, "").trim();
  if (source.length === 0) throw new InvalidJsonError("Model response was empty");

  // Strip a leading markdown fence and its matching closing fence.
  if (source.startsWith("```")) {
    const firstNewline = source.indexOf("\n");
    if (firstNewline !== -1) source = source.slice(firstNewline + 1);
    const closing = source.lastIndexOf("```");
    if (closing !== -1) source = source.slice(0, closing);
    source = source.trim();
  }

  const parseCandidate = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      return null;
    } catch {
      return null;
    }
  };

  const direct = parseCandidate(source);
  if (direct) return direct;

  // Find the first balanced object in the text (string/escape aware).
  const start = source.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const char = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(start, i + 1);
          const parsed = parseCandidate(candidate);
          if (parsed) return parsed;
          break;
        }
      }
    }
  }

  throw new InvalidJsonError("Model response did not contain a valid JSON object");
}

/** Resolves a dotted field path (e.g. `choices.0.message`) on an object. */
export function getField(object, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    return current[key];
  }, object);
}

/**
 * Validates required fields (dotted paths allowed) and their non-emptiness.
 * Returns the parsed object unchanged when valid; throws InvalidJsonError otherwise.
 */
export function validateRequiredFields(object, requiredFields = []) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    throw new InvalidJsonError("Expected a JSON object");
  }
  const missing = [];
  for (const field of requiredFields) {
    const value = getField(object, field);
    const emptyString = typeof value === "string" && value.trim().length === 0;
    if (value === undefined || value === null || emptyString) missing.push(field);
  }
  if (missing.length > 0) {
    throw new InvalidJsonError(`Model response is missing required field(s): ${missing.join(", ")}`);
  }
  return object;
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new OpenRouterError("At least one chat message is required", { code: "invalid_request" });
  }
  return messages.map((message) => ({
    role: message?.role,
    content: message?.content,
  }));
}

function clampTimeout(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(number, 10 * 60_000);
}

/**
 * Creates an OpenRouter client.
 *
 * @param {object} options
 * @param {string} options.apiKey OpenRouter key. Never logged or included in errors.
 * @param {string} [options.model] Default model id, e.g. `deepseek/deepseek-v4.1-flash-1017`.
 * @param {typeof fetch} [options.fetchImpl] Injectable fetch for offline tests.
 * @param {number} [options.timeoutMs=60000] Per-request timeout.
 * @param {string} [options.endpoint] Override for tests/proxies.
 * @param {object} [options.defaultHeaders] Extra headers (never secrets other than auth).
 */
export function createOpenRouterClient(options = {}) {
  const apiKey = options.apiKey;
  const defaultModel = options.model ?? "deepseek/deepseek-v4.1-flash-1017";
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = clampTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const defaultHeaders = options.defaultHeaders ?? {};

  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new OpenRouterError(
      "OpenRouter API key is required (set OPENROUTER_API_KEY)",
      { code: "missing_api_key" },
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new OpenRouterError("No fetch implementation available", { code: "missing_fetch" });
  }

  function safeError(message, extra = {}) {
    return new OpenRouterError(redactSecrets(message, apiKey), {
      ...extra,
      cause: extra.cause === undefined ? undefined : sanitizeErrorCause(extra.cause, apiKey),
    });
  }

  async function postChat(body, extraHeaders, signal) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          ...defaultHeaders,
          ...(extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw safeError(`OpenRouter request timed out after ${timeoutMs}ms`, { code: "timeout", cause: error });
      }
      throw safeError(`OpenRouter request failed: ${error?.message ?? error}`, {
        code: "network_error",
        cause: error,
      });
    }

    if (!response || typeof response.ok !== "boolean") {
      throw safeError("OpenRouter returned an invalid response object", { code: "invalid_response" });
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        detail = "";
      }
      detail = redactSecrets(String(detail).slice(0, MAX_ERROR_BODY_CHARS), apiKey).trim();
      throw safeError(
        `OpenRouter HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        { code: "http_error", status: response.status },
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw safeError("OpenRouter response was not valid JSON", { code: "invalid_response", cause: error });
    }
  }

  async function chat(request = {}) {
    const model = request.model ?? defaultModel;
    const messages = normalizeMessages(request.messages);
    const body = { model, messages };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.responseFormat !== undefined) body.response_format = request.responseFormat;
    if (request.reasoning !== undefined) body.reasoning = request.reasoning;
    if (request.extraBody && typeof request.extraBody === "object") Object.assign(body, request.extraBody);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const externalSignal = request.signal;
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const payload = await postChat(body, request.headers, controller.signal);
      const choice = payload?.choices?.[0];
      const content = normalizeContent(choice?.message?.content);
      if (content.trim().length > 0) {
        return {
          text: content,
          model: payload?.model ?? model,
          usage: payload?.usage ?? null,
          raw: payload,
        };
      }

      const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
      const reasoningTokens = Number(payload?.usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
      const hasReasoning = Boolean(choice?.message?.reasoning);
      const exhaustedByReasoning = finishReason === "length" && (reasoningTokens > 0 || hasReasoning);

      // Thinking models can spend the entire max_tokens budget on hidden reasoning and return empty content.
      // Recover once within the same timeout deadline by disabling reasoning and ensuring headroom.
      const alreadyDisabledWithHeadroom =
        body.reasoning?.enabled === false && Number(body.max_tokens ?? 0) >= 2048;
      if (exhaustedByReasoning && request.retryOnReasoningExhaustion !== false && !alreadyDisabledWithHeadroom) {
        const retryBody = {
          ...body,
          reasoning: { enabled: false },
          max_tokens: Math.max(Number(body.max_tokens) || 0, 2048),
        };
        try {
          const retryPayload = await postChat(retryBody, request.headers, controller.signal);
          const retryContent = normalizeContent(retryPayload?.choices?.[0]?.message?.content);
          if (retryContent.trim().length > 0) {
            return {
              text: retryContent,
              model: retryPayload?.model ?? model,
              usage: retryPayload?.usage ?? null,
              raw: retryPayload,
            };
          }
        } catch (retryError) {
          if (retryError?.code === "timeout") throw retryError;
          // Fall through so models that reject `reasoning.enabled: false` still surface the original empty_response.
        }
      }

      const details = [];
      if (finishReason) details.push(`finish_reason=${finishReason}`);
      if (reasoningTokens > 0) details.push(`reasoning_tokens=${reasoningTokens}`);
      else if (hasReasoning) details.push("reasoning_present=true");
      if (body.max_tokens !== undefined) details.push(`max_tokens=${body.max_tokens}`);
      const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
      throw safeError(`OpenRouter response contained no message content${suffix}`, { code: "empty_response" });
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }

  async function chatJson(request = {}) {
    const result = await chat(request);
    const data = validateRequiredFields(
      extractJsonObject(result.text),
      request.requiredFields ?? [],
    );
    return { data, text: result.text, model: result.model, usage: result.usage };
  }

  return { chat, chatJson, model: defaultModel, endpoint, timeoutMs };
}

/** Convenience factory reading OPENROUTER_API_KEY from the environment. */
export function createOpenRouterClientFromEnv(options = {}) {
  return createOpenRouterClient({
    ...options,
    apiKey: options.apiKey ?? process.env.OPENROUTER_API_KEY,
  });
}

export const OPENROUTER_DEFAULTS = Object.freeze({
  endpoint: DEFAULT_ENDPOINT,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});
