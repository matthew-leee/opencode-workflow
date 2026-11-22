/**
 * Secret redaction for the opencode-workflow audit logger.
 *
 * The audit log is append-only JSONL that a human (or a compliance tool) may read long
 * after the fact, so nothing that looks like a credential may reach it. This module
 * redacts in two independent ways:
 *
 *   1. structurally — object keys that name a credential are replaced wholesale;
 *   2. textually   — well-known token shapes and `KEY=value` assignments inside any
 *                    string are replaced inline.
 *
 * It is also the bound on record size: strings are redacted first and truncated afterwards
 * (so a credential that straddles the length limit is still replaced wholesale instead of
 * leaking a truncated prefix), the object walk has a depth limit and a node budget, and
 * circular references are cut.
 *
 * Everything here is pure and synchronous. It never throws on hostile input, including
 * revoked Proxy objects and getters that throw.
 */

export const REDACTED = '[REDACTED]';

/** Maximum characters of any single string that reaches the log. */
export const MAX_STRING_LENGTH = 4000;
/** Maximum object/array nesting that is still walked. */
export const MAX_DEPTH = 8;
/** Maximum array items kept per array. */
export const MAX_ARRAY_ITEMS = 200;
/** Maximum own keys kept per object. */
export const MAX_OBJECT_KEYS = 200;
/** Maximum values visited for one redact() call (bounds pathological input). */
export const MAX_NODES = 5000;

/**
 * Keys that are never credentials even though their name ends in "token". Provider
 * request options and usage reports legitimately carry these, and redacting them
 * would make the audit log useless for cost analysis.
 */
const NON_SECRET_TOKEN_KEYS = new Set([
  'maxtokens',
  'maxoutputtokens',
  'maxinputtokens',
  'tokencount',
  'tokenusage',
  'tokencost',
  'tokenlimit',
  'totalTokens'.toLowerCase(),
  'inputtokens',
  'outputtokens',
  'cachedtokens',
  'reasoningtokens',
  'tokens',
  'nanotokens',
]);

/**
 * Keys that end in "key" but are not credentials (sort keys, cache keys, `publicKey`).
 * Everything else ending in "key" is treated as a credential so provider-specific names
 * such as `OPENAI_KEY` are covered without an explicit entry for each provider.
 */
const NON_SECRET_KEY_KEYS = new Set([
  'key',
  'keys',
  'publickey',
  'sortkey',
  'cachekey',
  'partitionkey',
  'hotkey',
  'monkey',
  'primarykey',
  'foreignkey',
]);

/**
 * Normalized key names that always mean "this value is a credential".
 * Normalization strips spaces, `_` and `-` and lowercases, so `X-Api-Key`,
 * `x_api_key` and `xApiKey` all collapse to `xapikey`.
 */
const SENSITIVE_KEYS = new Set([
  'apikey',
  'xapikey',
  'authorization',
  'proxyauthorization',
  'auth',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'pass',
  'passphrase',
  'secret',
  'clientsecret',
  'privatekey',
  'credential',
  'credentials',
  'accesskey',
  'secretkey',
  'sessionkey',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'bearertoken',
  'sessiontoken',
  'csrftoken',
  'xsrf',
  'apitoken',
  // `env`/`environment` maps are redacted wholesale: logging a full process
  // environment is always a disclosure, whatever the individual key names are.
  'env',
  'environment',
]);

const SENSITIVE_SUFFIXES = [
  'apikey',
  'privatekey',
  'accesskey',
  'secretkey',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'token',
  'credential',
  'credentials',
  'cookie',
  'authorization',
  'key',
];

/** True when an object key names a credential. Hostile keys are stringified safely. */
export function isSensitiveKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  const normalized = key.toLowerCase().replace(/[\s_.-]+/g, '');
  if (NON_SECRET_TOKEN_KEYS.has(normalized)) return false;
  if (NON_SECRET_KEY_KEYS.has(normalized)) return false;
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

// --- textual patterns -------------------------------------------------------------

/** `Bearer <token>` (HTTP authorization headers, curl commands, log lines). */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** `Basic <base64>` (HTTP basic auth). */
const BASIC = /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi;
/** Provider keys: sk-..., sk-or-v1-..., sk-proj-..., etc. */
const SK_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g;
/** GitHub tokens. */
const GITHUB_TOKEN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g;
const GITHUB_PAT = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;
/** Slack tokens. */
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
/** AWS access key ids. */
const AWS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
/** Google API keys. */
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/g;
/** JWTs (header.payload.signature). */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
/** PEM private key blocks, including the body. */
const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
/**
 * Fail-closed PEM: a private-key header without its END marker means the rest of the
 * input is key material (usually because a log line was cut short). Redact the whole tail.
 * It runs after the closed-block rule, so a complete key never swallows what follows it.
 */
const PEM_PRIVATE_KEY_UNCLOSED = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g;
/** A header that was itself cut mid-way, e.g. "-----BEGIN RSA PRIV". */
const PEM_PARTIAL_TAIL = /-----BEGIN(?:[ A-Z0-9-]*PRIV[A-Z0-9-]*)?$/;
/** Inline base64 media (a read/image tool can return megabytes in one string). */
const DATA_URL = /data:[a-z0-9/+.-]+;base64,[A-Za-z0-9+/=\s]+/gi;
/** Credentials embedded in a URL authority: scheme://user:password@host. */
const URL_USERINFO = /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s:@/]*):([^\s@/]+)@/g;

/**
 * Bare `KEY=value` / `KEY: value` assignments. The name pattern is deliberately generic
 * (any identifier, with optional dot/hyphen segments); the replacement callback re-checks
 * it with isSensitiveKey(), so `MAX_TOKENS=4096` survives while `OPENAI_KEY=...`,
 * `PASSWORD=hunter2` and `TOKEN=secretvalue` are replaced without requiring a known prefix.
 * The negative lookbehind stops a match in the middle of a longer identifier.
 */
const ENV_ASSIGN =
  /(?<![A-Za-z0-9_.$-])([A-Za-z_][A-Za-z0-9_.-]{0,127})(\s*[=:]\s*)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|Bearer\s+\[REDACTED\]|Basic\s+\[REDACTED\]|[^\s,;&|"'`]+)/g;

/**
 * Quoted-key assignments, i.e. JSON/JS objects: `{"apiKey":"value"}` or `'token': 'x'`.
 * The key is re-checked with isSensitiveKey(); quoted values stay quoted so the result is
 * still readable (and still valid JSON when the input was).
 */
const QUOTED_ASSIGN =
  /(["'])([^"'\\\n]{1,128})\1(\s*:\s*)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\s,};&|]+)/g;

function quoteReplacement(value) {
  const quote = value[0];
  return quote === '"' || quote === "'" ? `${quote}${REDACTED}${quote}` : REDACTED;
}

/**
 * `Authorization: Bearer [REDACTED]` is the output of the dedicated BEARER/BASIC rules. Keep
 * that readable shape instead of collapsing the scheme word into another marker.
 */
function isAlreadyRedactedScheme(value) {
  return /^(?:Bearer|Basic)\s+\[REDACTED\]$/.test(value);
}

function replaceEnvAssignment(match, key, separator, value) {
  if (isAlreadyRedactedScheme(value)) return match;
  // Unquoted assignments are log text, not JSON: emit the plain marker (matching the
  // historical `DB_PASSWORD="hunter2"` -> `DB_PASSWORD=[REDACTED]` shape).
  return isSensitiveKey(key) ? `${key}${separator}${REDACTED}` : match;
}

function replaceQuotedAssignment(match, quote, key, separator, value) {
  if (isAlreadyRedactedScheme(value)) return match;
  return isSensitiveKey(key) ? `${quote}${key}${quote}${separator}${quoteReplacement(value)}` : match;
}

/** Cut a string to maxLength characters, marking exactly how much was dropped. */
export function truncateString(value, maxLength = MAX_STRING_LENGTH) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const limit = Number.isFinite(maxLength) && maxLength >= 0 ? Math.floor(maxLength) : MAX_STRING_LENGTH;
  if (text.length <= limit) return text;
  let end = limit;
  // Do not split a surrogate pair in half.
  const code = end > 0 ? text.charCodeAt(end - 1) : 0;
  if (code >= 0xd800 && code <= 0xdbff) end = Math.max(0, end - 1);
  return `${text.slice(0, end)}…[truncated ${text.length - end} chars]`;
}

/**
 * Redact secrets inline in a string, then bound its length.
 *
 * Order matters: redaction runs over the whole input **before** truncation. Truncating
 * first can split a credential at the length boundary (the first 4,000 characters of a
 * PEM key body or an `sk-...` token are still secret), which was a real leak. The
 * fail-closed PEM rules run before truncation for the same reason.
 */
export function redactString(value, options = {}) {
  const maxLength = options.maxLength ?? MAX_STRING_LENGTH;
  let text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length === 0) return text;

  // Complete PEM blocks first, then any header that has no END marker: from there on the
  // rest of the string is key material, so it is replaced wholesale.
  text = text.replace(PEM_PRIVATE_KEY, '[REDACTED PRIVATE KEY]');
  text = text.replace(PEM_PRIVATE_KEY_UNCLOSED, '[REDACTED_PRIVATE_KEY]');
  text = text.replace(PEM_PARTIAL_TAIL, '[REDACTED_PRIVATE_KEY]');
  text = text.replace(DATA_URL, '[REDACTED DATA URL]');
  text = text.replace(URL_USERINFO, `$1$2:${REDACTED}@`);
  text = text.replace(BEARER, `Bearer ${REDACTED}`);
  text = text.replace(BASIC, `Basic ${REDACTED}`);
  text = text.replace(JWT, REDACTED);
  text = text.replace(SK_KEY, REDACTED);
  text = text.replace(GITHUB_PAT, REDACTED);
  text = text.replace(GITHUB_TOKEN, REDACTED);
  text = text.replace(SLACK_TOKEN, REDACTED);
  text = text.replace(AWS_KEY_ID, REDACTED);
  text = text.replace(GOOGLE_API_KEY, REDACTED);
  text = text.replace(QUOTED_ASSIGN, replaceQuotedAssignment);
  text = text.replace(ENV_ASSIGN, replaceEnvAssignment);
  return truncateString(text, maxLength);
}

// --- deep walk --------------------------------------------------------------------

function define(target, key, value) {
  try {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } catch {
    // A non-extensible target or a hostile key: dropping the field is fine.
  }
}

// Hostile and revoked-Proxy inputs: every reflective operation is individually guarded so
// a trap that throws can never escape redact(). `typeof` is safe for a revoked Proxy, but
// `instanceof`, `Array.isArray`, property reads and Object.keys are not.
function safeGet(object, key) {
  try {
    return object?.[key];
  } catch {
    return undefined;
  }
}

function safeInstanceOf(value, constructor) {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
}

function safeIsArray(value) {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function isBinary(value) {
  try {
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true;
    return ArrayBuffer.isView(value) || safeInstanceOf(value, ArrayBuffer);
  } catch {
    return false;
  }
}

function binarySize(value) {
  try {
    if (typeof value.byteLength === 'number') return value.byteLength;
    if (typeof value.length === 'number') return value.length;
  } catch {
    // Revoked Proxy / hostile getter.
  }
  return 0;
}

function redactedName(error, maxLength) {
  const name = safeGet(error, 'name');
  return redactString(typeof name === 'string' && name.length > 0 ? name : 'Error', { maxLength });
}

function walkError(error, depth, config, state) {
  const summary = {
    // Error.name is attacker-controlled just like Error.message (providers and SDKs put
    // tokens in both), so it gets the same redaction and length cap.
    name: redactedName(error, config.maxStringLength),
    message: redactString(String(safeGet(error, 'message') ?? ''), {
      maxLength: config.maxStringLength,
    }),
  };
  try {
    const code = safeGet(error, 'code');
    if (typeof code !== 'undefined') {
      summary.code = walk(code, depth + 1, config, state);
    }
    const stack = safeGet(error, 'stack');
    if (typeof stack === 'string' && config.includeStacks) {
      summary.stack = redactString(stack, { maxLength: config.maxStringLength });
    }
    const cause = safeGet(error, 'cause');
    if (typeof cause !== 'undefined') {
      summary.cause = walk(cause, depth + 1, config, state);
    }
    const metadata = safeGet(error, 'metadata');
    if (typeof metadata !== 'undefined') {
      summary.metadata = walk(metadata, depth + 1, config, state);
    }
  } catch {
    // Hostile getters: keep the partial summary.
  }
  return summary;
}

function walk(value, depth, config, state) {
  state.nodes += 1;
  if (state.nodes > config.maxNodes) return '[Truncated: too many values]';
  if (value === null) return null;

  const type = typeof value;
  if (type === 'string') return redactString(value, { maxLength: config.maxStringLength });
  if (type === 'number') return Number.isFinite(value) ? value : String(value);
  if (type === 'boolean') return value;
  if (type === 'undefined') return '[undefined]';
  if (type === 'bigint') return `${value.toString()}n`;
  if (type === 'symbol') return String(value);
  if (type === 'function') return `[Function ${safeGet(value, 'name') || 'anonymous'}]`;

  // Objects only from here down.
  if (depth >= config.maxDepth) return '[MaxDepth]';
  if (state.ancestors.has(value)) return '[Circular]';
  if (isBinary(value)) return `<binary ${binarySize(value)} bytes>`;

  state.ancestors.add(value);
  try {
    if (safeInstanceOf(value, Date)) {
      const time = value.getTime();
      return Number.isNaN(time) ? 'Invalid Date' : value.toISOString();
    }
    if (safeInstanceOf(value, Error)) {
      return walkError(value, depth, config, state);
    }
    if (safeIsArray(value)) {
      const items = [];
      const limit = Math.min(value.length, config.maxArrayItems);
      for (let index = 0; index < limit; index += 1) {
        let item;
        try {
          item = value[index];
        } catch {
          item = '[Unreadable]';
        }
        items.push(walk(item, depth + 1, config, state));
      }
      if (value.length > limit) {
        items.push(`[${value.length - limit} more items]`);
      }
      return items;
    }
    if (safeInstanceOf(value, Map)) {
      const entries = [];
      for (const [key, item] of value) {
        if (entries.length >= config.maxArrayItems) break;
        entries.push([walk(key, depth + 1, config, state), walk(item, depth + 1, config, state)]);
      }
      return { type: 'Map', entries };
    }
    if (safeInstanceOf(value, Set)) {
      const values = [];
      for (const item of value) {
        if (values.length >= config.maxArrayItems) break;
        values.push(walk(item, depth + 1, config, state));
      }
      return { type: 'Set', values };
    }

    const output = {};
    let keys;
    try {
      keys = Object.keys(value);
    } catch {
      return '[Unreadable]';
    }
    const limit = Math.min(keys.length, config.maxObjectKeys);
    for (let index = 0; index < limit; index += 1) {
      const key = keys[index];
      if (isSensitiveKey(key)) {
        define(output, key, REDACTED);
        continue;
      }
      let item;
      try {
        item = value[key];
      } catch {
        item = '[Unreadable]';
      }
      define(output, key, walk(item, depth + 1, config, state));
    }
    if (keys.length > limit) {
      define(output, '[truncatedKeys]', keys.length - limit);
    }
    return output;
  } catch {
    // A revoked Proxy, a Map iterator that throws, or any other hostile object: record
    // that it was unreadable instead of letting the exception out of redact().
    return '[Unreadable]';
  } finally {
    state.ancestors.delete(value);
  }
}

/**
 * Deep-copy `value` with secrets redacted and size bounded.
 *
 * Safe for circular structures, getters that throw, buffers, Errors, Maps and Sets.
 * The result is always JSON-serializable (except for lone surrogates, which
 * JSON.stringify escapes).
 */
export function redact(value, options = {}) {
  const config = {
    maxStringLength: options.maxStringLength ?? MAX_STRING_LENGTH,
    maxDepth: options.maxDepth ?? MAX_DEPTH,
    maxArrayItems: options.maxArrayItems ?? MAX_ARRAY_ITEMS,
    maxObjectKeys: options.maxObjectKeys ?? MAX_OBJECT_KEYS,
    maxNodes: options.maxNodes ?? MAX_NODES,
    includeStacks: options.includeStacks === true,
  };
  const state = { nodes: 0, ancestors: new WeakSet() };
  return walk(value, 0, config, state);
}
