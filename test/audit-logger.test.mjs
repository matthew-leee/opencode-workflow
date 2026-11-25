/**
 * Offline tests for the opencode-workflow audit logger.
 *
 * No paid model API is called anywhere in this file. The final test boots the real
 * OpenCode v2.3.2 binary with isolated XDG directories and only runs `debug` commands
 * (configuration source listing and agent listing), which never contact a model.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import auditPlugin, {
  AUDIT_DIR_ENV,
  BoundedCallMap,
  DISPOSE_TIMEOUT_MS,
  EVENT_TYPES,
  MAX_LINE_CHARS,
  MAX_PENDING_CALLS,
  PLUGIN_ID,
  createAuditLog,
  defaultAuditDir,
  describeError,
  redact,
  redactString,
  resolveAuditDir,
  summarizeError,
  summarizeToolResult,
} from '../plugins/audit-logger/index.js';
import {
  MAX_STRING_LENGTH,
  REDACTED,
  isSensitiveKey,
  truncateString,
} from '../plugins/audit-logger/redact.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const OPENCODE_BIN = '/root/.opencode/bin/opencode';

// --- helpers ----------------------------------------------------------------------

function makeTempDir(t, prefix = 'ocw-audit-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function useAuditDir(t, dir) {
  const previous = process.env[AUDIT_DIR_ENV];
  process.env[AUDIT_DIR_ENV] = dir;
  t.after(() => {
    if (previous === undefined) delete process.env[AUDIT_DIR_ENV];
    else process.env[AUDIT_DIR_ENV] = previous;
  });
}

function jsonlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => path.join(dir, name));
}

function readRecords(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSONL on line ${index + 1} of ${file}: ${error.message}`);
      }
    });
}

function allRecords(dir) {
  return jsonlFiles(dir).flatMap(readRecords);
}

async function waitFor(predicate, options = {}) {
  const timeout = options.timeout ?? 5000;
  const interval = options.interval ?? 20;
  const startedAt = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling helper
    const value = await predicate();
    if (value) return value;
    if (Date.now() - startedAt > timeout) {
      throw new Error(options.message ?? 'waitFor timed out');
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * Minimal stand-in for the @opencode/plugin Context. It records every hook the plugin
 * registers, replays a scripted event stream, and lets the test invoke hooks directly.
 */
function createMockContext({ app, location, options, events = [], subscribeImpl } = {}) {
  const callbacks = new Map();
  const registrations = [];
  const signals = [];
  const streamState = { finished: false };

  const makeDomain = (domainName) => ({
    async hook(hookName, callback) {
      const key = `${domainName}.${hookName}`;
      callbacks.set(key, callback);
      const registration = {
        key,
        disposeCalls: 0,
        async dispose() {
          registration.disposeCalls += 1;
          callbacks.delete(key);
        },
      };
      registrations.push(registration);
      return registration;
    },
  });

  const event = {
    subscribe(subscribeOptions = {}) {
      if (typeof subscribeImpl === 'function') return subscribeImpl(subscribeOptions);
      const signal = subscribeOptions.signal;
      signals.push({ signal, options: subscribeOptions });
      return (async function* scriptedEvents() {
        try {
          for (const value of events) {
            if (signal?.aborted) return;
            yield value;
            // Let the consumer loop run and let cleanup abort between events.
            await new Promise((resolve) => setImmediate(resolve));
          }
          if (!signal) return;
          await new Promise((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', resolve, { once: true });
          });
        } finally {
          streamState.finished = true;
        }
      })();
    },
  };

  const ctx = {
    app: app ?? { name: 'opencode', version: '2.3.2', channel: 'latest' },
    location: location ?? { directory: '/tmp/project' },
    options: options ?? {},
    session: makeDomain('session'),
    tool: makeDomain('tool'),
    permission: makeDomain('permission'),
    shell: makeDomain('shell'),
    event,
  };

  return {
    ctx,
    callbacks,
    registrations,
    signals,
    streamState,
    async call(name, input) {
      const callback = callbacks.get(name);
      assert.ok(callback, `hook ${name} was not registered`);
      return callback(input);
    },
  };
}

// --- redaction --------------------------------------------------------------------

test('isSensitiveKey recognizes credential names and ignores token counts', () => {
  for (const key of [
    'apiKey',
    'api_key',
    'API-KEY',
    'x-api-key',
    'X-Api-Key',
    'token',
    'access_token',
    'refreshToken',
    'password',
    'passwd',
    'secret',
    'client_secret',
    'authorization',
    'Authorization',
    'cookie',
    'credential',
    'credentials',
    'private_key',
    'privateKey',
    'x-auth-token',
    'env',
    'environment',
  ]) {
    assert.equal(isSensitiveKey(key), true, `${key} should be sensitive`);
  }

  for (const key of [
    'max_tokens',
    'maxTokens',
    'max_output_tokens',
    'tokenUsage',
    'tokens',
    'inputTokens',
    'outputTokens',
    'cachedTokens',
    'content',
    'model',
    'filePath',
  ]) {
    assert.equal(isSensitiveKey(key), false, `${key} should not be sensitive`);
  }
  assert.equal(isSensitiveKey(''), false);
  assert.equal(isSensitiveKey(42), false);
});

test('redact removes secrets from nested objects and redacts whole env maps', () => {
  const input = {
    apiKey: 'plain-secret-1',
    headers: {
      Authorization: 'Bearer abcdefghijklmnop',
      'x-api-key': 'plain-secret-2',
      'Content-Type': 'application/json',
    },
    nested: { database: { password: 'hunter2', user: 'admin' } },
    tokenUsage: { input: 10, output: 20 },
    max_tokens: 100,
    tokens: 42,
    env: { PATH: '/usr/bin', OPENROUTER_API_KEY: 'sk-or-v1-abcdefghijklmnop' },
  };

  const output = redact(input);

  assert.equal(output.apiKey, REDACTED);
  assert.equal(output.headers.Authorization, REDACTED);
  assert.equal(output.headers['x-api-key'], REDACTED);
  assert.equal(output.headers['Content-Type'], 'application/json');
  assert.equal(output.nested.database.password, REDACTED);
  assert.equal(output.nested.database.user, 'admin');
  assert.deepEqual(output.tokenUsage, { input: 10, output: 20 });
  assert.equal(output.max_tokens, 100);
  assert.equal(output.tokens, 42);
  assert.equal(output.env, REDACTED);
  assert.deepEqual(input.nested.database, { password: 'hunter2', user: 'admin' }, 'input is not mutated');

  const serialized = JSON.stringify(output);
  for (const secret of ['plain-secret-1', 'plain-secret-2', 'hunter2', 'abcdefghijklmnop']) {
    assert.ok(!serialized.includes(secret), `${secret} leaked`);
  }
});

test('redact cuts circular references, bounds depth, and survives hostile getters', () => {
  const root = { name: 'root' };
  root.self = root;
  root.child = { parent: root };
  const circular = redact(root);
  assert.equal(circular.self, '[Circular]');
  assert.equal(circular.child.parent, '[Circular]');

  const deep = {};
  let cursor = deep;
  for (let index = 0; index < 40; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  assert.ok(JSON.stringify(redact(deep)).includes('[MaxDepth]'));

  const hostile = {
    safe: 'ok',
    get boom() {
      throw new Error('getter exploded');
    },
  };
  const hostileOut = redact(hostile);
  assert.equal(hostileOut.safe, 'ok');
  assert.equal(hostileOut.boom, '[Unreadable]');

  const array = [];
  array.push(array);
  assert.equal(redact(array)[0], '[Circular]');
});

test('redactString redacts Bearer, sk-or, Basic, GitHub, JWT, env and URL secrets', () => {
  const cases = [
    ['Authorization: Bearer abcdefghijklmnop', 'Bearer [REDACTED]'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Basic [REDACTED]'],
    ['key sk-or-v1-1234567890abcdef', '[REDACTED]'],
    ['key sk-proj-1234567890abcdef', '[REDACTED]'],
    ['ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '[REDACTED]'],
    ['github_pat_11AAAAAAAAAAAAAAAAAAAAAAAA', '[REDACTED]'],
    ['slack xoxb-1234567890-abcdefghij', '[REDACTED]'],
    ['aws AKIAABCDEFGHIJKLMNOP', '[REDACTED]'],
    ['AKIAABCDEFGHIJKLMNOP', '[REDACTED]'],
    ['OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnop', 'OPENROUTER_API_KEY=[REDACTED]'],
    ['DB_PASSWORD="hunter2"', 'DB_PASSWORD=[REDACTED]'],
    ['export GITHUB_TOKEN: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'GITHUB_TOKEN: [REDACTED]'],
    ['postgres://app:hunter2@db.internal:5432/app', 'postgres://app:[REDACTED]@db.internal'],
    ['https://user:pass@example.com/path', 'https://user:[REDACTED]@example.com/path'],
    ['MAX_TOKENS=4096', 'MAX_TOKENS=4096'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', '[REDACTED]'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', '[REDACTED PRIVATE KEY]'],
    ['image data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', '[REDACTED DATA URL]'],
  ];

  for (const [input, expected] of cases) {
    const output = redactString(input);
    assert.ok(output.includes(expected), `expected ${JSON.stringify(expected)} in ${JSON.stringify(output)}`);
  }

  // Secrets that must not survive any of the pattern paths.
  for (const secret of [
    'abcdefghijklmnop',
    'dXNlcjpwYXNzd29yZA==',
    'hunter2',
    'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AKIAABCDEFGHIJKLMNOP',
    'iVBORw0KGgoAAAANSUhEUg==',
  ]) {
    assert.ok(!redactString(cases.map(([value]) => value).join('\n')).includes(secret), `${secret} leaked`);
  }
});

test('redactString redacts bare credential assignments and textual JSON pairs', () => {
  // Regression (reviewer Part A): `PASSWORD=hunter2`, `OPENAI_KEY=...` and
  // `{"apiKey":"..."}` used to pass through untouched because the assignment regex only
  // matched a fixed list of key prefixes and ignored quoted JSON keys entirely.
  const cases = [
    ['PASSWORD=hunter2', 'hunter2'],
    ['TOKEN=secretvalue', 'secretvalue'],
    ['API_KEY=secretvalue', 'secretvalue'],
    ['OPENAI_KEY=supersecretvalue', 'supersecretvalue'],
    ['{"apiKey":"supersecretvalue"}', 'supersecretvalue'],
    ["{ 'clientSecret': 'supersecretvalue' }", 'supersecretvalue'],
    ['database_password: hunter2', 'hunter2'],
  ];

  for (const [input, secret] of cases) {
    const output = redactString(input);
    assert.ok(output.includes(REDACTED), `expected a redaction in ${JSON.stringify(output)}`);
    assert.ok(!output.includes(secret), `${secret} leaked from ${JSON.stringify(input)}`);
  }

  // Quoted values stay quoted, so a textual JSON record remains readable/parseable.
  assert.equal(redactString('{"apiKey":"supersecretvalue"}'), '{"apiKey":"[REDACTED]"}');

  // Redaction happens before the 4,000-char cap, so an assignment straddling the boundary is
  // replaced whole and no prefix of the value survives.
  const boundaryAssignment = `${'x'.repeat(MAX_STRING_LENGTH - 6)} PASSWORD=hunter2`;
  const boundaryOutput = redactString(boundaryAssignment);
  assert.ok(!boundaryOutput.includes('hunt'), 'no prefix of the secret may survive');
  assert.ok(boundaryOutput.includes('PASSWORD=[REDACTED]') || boundaryOutput.includes('[truncated'));

  // Non-credential names must still survive untouched.
  assert.equal(redactString('MAX_TOKENS=4096'), 'MAX_TOKENS=4096');
  assert.equal(redactString('name: opencode'), 'name: opencode');
  assert.equal(redactString('"Content-Type": "application/json"'), '"Content-Type": "application/json"');

  // Provider-specific key names are sensitive structurally too.
  assert.equal(isSensitiveKey('OPENAI_KEY'), true);
  assert.equal(isSensitiveKey('publicKey'), false);
  assert.deepEqual(redact({ OPENAI_KEY: 'supersecretvalue' }), { OPENAI_KEY: REDACTED });
});

test('redactString fail-closes an unclosed PEM block before the 4000-char cap', () => {
  // Regression (reviewer Part A): truncating first cut the key body at 4,000 characters,
  // so the unfindable END marker left raw SECRETKEYMATERIAL in the audit log.
  const body = 'SECRETKEYMATERIAL'.repeat(400);
  const truncatedPem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n`;
  const output = redactString(truncatedPem);
  assert.ok(output.includes('[REDACTED_PRIVATE_KEY]'));
  assert.ok(!output.includes('SECRETKEYMATERIAL'));
  assert.ok(output.length <= MAX_STRING_LENGTH + 64);

  // The same block straddling the cap boundary must not leak a prefix either.
  const prefixed = `${'a'.repeat(MAX_STRING_LENGTH - 10)}${truncatedPem}`;
  const prefixedOutput = redactString(prefixed);
  assert.ok(!prefixedOutput.includes('SECRETKEYMATERIAL'));
  assert.ok(prefixedOutput.includes('[truncated'));

  // A token that begins just before the cap and continues past it is still removed wholesale.
  const tokenAtBoundary = `${'b'.repeat(MAX_STRING_LENGTH - 4)} sk-abcdefghijklmnopqrstuvwxyz`;
  const tokenOutput = redactString(tokenAtBoundary);
  assert.ok(!tokenOutput.includes('sk-'), 'no prefix of the token may survive');
  assert.ok(tokenOutput.includes('[truncated'));

  // A complete block is still replaced by the readable marker, and following text survives.
  assert.equal(
    redactString(
      'before -----BEGIN RSA PRIVATE KEY-----\nKEYMAT\n-----END RSA PRIVATE KEY----- after',
    ),
    'before [REDACTED PRIVATE KEY] after',
  );

  // A header that was itself cut mid-way is a fail-closed tail.
  assert.equal(redactString('prefix -----BEGIN RSA PRIV'), 'prefix [REDACTED_PRIVATE_KEY]');
});

test('Error.name is redacted and length-capped like Error.message', () => {
  // Regression (reviewer Part A): only Error.message was redacted; a token in .name leaked.
  const error = new Error('plain failure');
  error.name = 'sk-abcdefghijklmnop';
  const output = redact({ error });
  assert.equal(output.error.name, REDACTED);
  assert.ok(!JSON.stringify(output).includes('sk-abcdefghijklmnop'));

  const longName = new Error('plain failure');
  longName.name = `${'n'.repeat(10_000)}sk-abcdefghijklmnop`;
  const capped = redact({ error: longName });
  assert.ok(capped.error.name.length < 10_000);
  assert.ok(capped.error.name.includes('[truncated'));
  assert.ok(!capped.error.name.includes('sk-abcdefghijklmnop'));

  // The index.js structured-error summary applies the same treatment.
  const summarized = summarizeError(Object.assign(new Error('plain failure'), { name: 'sk-abcdefghijklmnop' }));
  assert.equal(summarized.name, REDACTED);
  const longSummary = summarizeError(
    Object.assign(new Error('plain failure'), {
      name: `${'n'.repeat(5_000)}sk-abcdefghijklmnop`,
    }),
  );
  assert.ok(longSummary.name.length <= 1_000 + 40);
  assert.ok(!longSummary.name.includes('sk-abcdefghijklmnop'));
});

test('redact never throws on revoked Proxy objects', () => {
  // Regression (reviewer Part A): `instanceof`, `Array.isArray` and property reads all throw
  // for a revoked Proxy, so a hostile tool payload could escape redact() and take down a hook.
  const revoked = Proxy.revocable({ apiKey: 'LEAKME' }, {});
  revoked.revoke();

  let output;
  assert.doesNotThrow(() => {
    output = redact({ direct: revoked.proxy, list: [revoked.proxy], nested: { value: revoked.proxy } });
  });
  assert.equal(output.direct, '[Unreadable]');
  assert.equal(output.list[0], '[Unreadable]');
  assert.equal(output.nested.value, '[Unreadable]');
  assert.equal(redact(revoked.proxy), '[Unreadable]');

  const revokedError = Proxy.revocable(new Error('boom'), {});
  revokedError.revoke();
  assert.doesNotThrow(() => redact({ error: revokedError.proxy }));
  assert.doesNotThrow(() => summarizeError(revokedError.proxy));
  assert.doesNotThrow(() => describeError(revokedError.proxy));

  const revokedFunction = Proxy.revocable(function named() {}, {});
  revokedFunction.revoke();
  assert.doesNotThrow(() => redact({ fn: revokedFunction.proxy }));
});

test('redactString and redact bound giant strings and binary payloads', () => {
  const giant = `${'x'.repeat(20000)}OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnop`;
  const output = redactString(giant);
  assert.ok(output.length < 20000);
  assert.ok(output.includes('[truncated'));
  assert.ok(!output.includes('sk-or-v1-abcdefghijklmnop'));
  assert.ok(output.startsWith('x'));

  assert.equal(truncateString('abc', 10), 'abc');
  assert.equal(truncateString('abcdef', 3), 'abc…[truncated 3 chars]');
  const atDefaultLimit = redactString('q'.repeat(MAX_STRING_LENGTH + 10));
  assert.ok(atDefaultLimit.startsWith('q'.repeat(MAX_STRING_LENGTH)));
  assert.ok(atDefaultLimit.includes('[truncated 10 chars]'));
  assert.equal(redactString('trigger Bearer abcdefghijklmnop', { maxLength: 10 }).includes('Bearer'), false);

  const binary = redact({ blob: Buffer.from('super-secret-value'), view: new Uint8Array(8) });
  assert.equal(binary.blob, '<binary 18 bytes>');
  assert.equal(binary.view, '<binary 8 bytes>');
  assert.ok(!JSON.stringify(binary).includes('super-secret-value'));

  const error = new Error('request failed with sk-or-v1-abcdefghijklmnop');
  error.code = 'EAUTH';
  const withError = redact({ error });
  assert.equal(withError.error.name, 'Error');
  assert.equal(withError.error.code, 'EAUTH');
  assert.ok(withError.error.message.includes('[REDACTED]'));
  assert.ok(!withError.error.message.includes('sk-or-v1-abcdefghijklmnop'));

  assert.deepEqual(redact({ nan: NaN, inf: Infinity, big: 42n }), {
    nan: 'NaN',
    inf: 'Infinity',
    big: '42n',
  });
});

test('summarizeToolResult keeps sizes and previews, not payloads', () => {
  const summary = summarizeToolResult({
    content: [
      { type: 'text', text: `body ${'y'.repeat(10000)}` },
      { type: 'file', uri: 'file:///tmp/a.png', mime: 'image/png', name: 'a.png' },
    ],
    metadata: { token: 'LEAKME', count: 1 },
  });

  assert.equal(summary.content.type, 'parts');
  assert.equal(summary.content.count, 2);
  assert.equal(summary.content.parts[0].type, 'text');
  assert.equal(summary.content.parts[0].chars, 10005);
  assert.ok(summary.content.parts[0].preview.length <= 500 + 40);
  assert.equal(summary.content.parts[1].uri, 'file:///tmp/a.png');
  assert.equal(summary.metadata.token, REDACTED);
  assert.equal(summary.metadata.count, 1);
  assert.ok(!JSON.stringify(summary).includes('LEAKME'));
  assert.ok(!JSON.stringify(summary).includes('y'.repeat(1000)));
});

// --- writer -----------------------------------------------------------------------

test('createAuditLog appends daily JSONL with 0700 dir and 0600 file modes', (t) => {
  const root = makeTempDir(t);
  const directory = path.join(root, 'audit');
  const first = createAuditLog({
    directory,
    clock: () => new Date('2026-01-02T03:04:05.678Z'),
  });
  assert.equal(first.enabled, true);
  assert.equal(first.directory, directory);
  assert.equal(first.record('plugin.loaded', { hello: 'world' }), true);
  first.close();

  const file = path.join(directory, '2026-01-02.jsonl');
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const second = createAuditLog({
    directory,
    clock: () => new Date('2026-01-02T04:00:00.000Z'),
  });
  second.record('second', {});
  second.close();

  const records = readRecords(file);
  assert.equal(records.length, 2);
  assert.equal(records[0].ts, '2026-01-02T03:04:05.678Z');
  assert.equal(records[0].v, 1);
  assert.equal(records[0].event, 'plugin.loaded');
  assert.equal(records[0].hello, 'world');
  assert.equal(records[1].event, 'second');

  // A closed writer is inert: a late hook must not resurrect the descriptor.
  assert.equal(second.record('late', {}), false);
  assert.equal(readRecords(file).length, 2);

  // Day rollover opens a new file instead of mixing days.
  const third = createAuditLog({
    directory,
    clock: () => new Date('2026-01-03T00:00:01.000Z'),
  });
  assert.equal(third.record('new-day', {}), true);
  third.close();
  assert.ok(fs.existsSync(path.join(directory, '2026-01-03.jsonl')));
  assert.equal(readRecords(path.join(directory, '2026-01-03.jsonl')).length, 1);
});

test('createAuditLog tightens pre-existing permissive directory and file modes', (t) => {
  const directory = path.join(makeTempDir(t), 'audit');
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  fs.chmodSync(directory, 0o755);
  const file = path.join(directory, '2026-02-03.jsonl');
  fs.writeFileSync(file, '{"event":"pre-existing"}\n');
  fs.chmodSync(file, 0o644);

  const log = createAuditLog({ directory, clock: () => new Date('2026-02-03T01:00:00.000Z') });
  assert.equal(log.record('new', {}), true);
  log.close();

  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const records = readRecords(file);
  assert.equal(records.length, 2);
  assert.equal(records[0].event, 'pre-existing');
  assert.equal(records[1].event, 'new');
});

test('createAuditLog refuses symlinks and non-regular files at the daily path (fail-closed)', (t) => {
  // Regression (reviewer Part A): opening the day file with "a" followed a symlink, so a
  // link planted at <day>.jsonl made the logger append into an arbitrary target.
  const root = makeTempDir(t);
  const directory = path.join(root, 'audit');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(root, 'outside.txt');
  fs.writeFileSync(target, 'ORIGINAL CONTENT\n');
  const link = path.join(directory, '2026-04-05.jsonl');
  fs.symlinkSync(target, link);

  const log = createAuditLog({ directory, clock: () => new Date('2026-04-05T00:00:00.000Z') });
  assert.equal(log.record('leak', { apiKey: 'LEAKME' }), false);
  assert.equal(log.enabled, false);
  assert.match(log.disabledReason, /regular file/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL CONTENT\n', 'symlink target untouched');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'symlink was not replaced');

  // A directory squatting on the file name is not a regular file either (a FIFO is covered by
  // its own test below).
  fs.unlinkSync(link);
  const squatter = path.join(directory, '2026-04-05.jsonl');
  fs.mkdirSync(squatter);
  const second = createAuditLog({ directory, clock: () => new Date('2026-04-05T00:00:00.000Z') });
  assert.equal(second.record('leak', {}), false);
  assert.equal(second.enabled, false);
  assert.match(second.disabledReason, /regular file/);
  assert.deepEqual(fs.readdirSync(squatter), []);

  // A symlinked audit directory is refused before any chmod can touch its target.
  const realDir = path.join(root, 'real-audit');
  fs.mkdirSync(realDir, { recursive: true, mode: 0o755 });
  fs.chmodSync(realDir, 0o755);
  const linkedDir = path.join(root, 'linked-audit');
  fs.symlinkSync(realDir, linkedDir);
  const third = createAuditLog({ directory: linkedDir });
  assert.equal(third.enabled, false);
  assert.match(third.disabledReason, /not a real directory/);
});

test('createAuditLog fails closed when 0600 cannot be verified after fchmod', (t) => {
  // Regression (reviewer Part A): chmod failures were silently ignored, so a pre-existing
  // 0644 file kept receiving redacted-but-still-sensitively-shaped log records.
  const root = makeTempDir(t);
  const directory = path.join(root, 'audit');
  const fake = Object.create(fs);
  fake.openSync = (file, flags) => fs.openSync(file, flags, 0o644);
  fake.fchmodSync = () => {}; // reports success without changing the mode

  const log = createAuditLog({
    directory,
    fileSystem: fake,
    clock: () => new Date('2026-05-06T00:00:00.000Z'),
  });
  assert.equal(log.record('secret', { token: 'LEAKME' }), false);
  assert.equal(log.enabled, false);
  assert.match(log.disabledReason, /0600/);

  const file = path.join(directory, '2026-05-06.jsonl');
  assert.equal(fs.statSync(file).mode & 0o777, 0o644, 'the unsafe file was left alone');
  assert.equal(fs.readFileSync(file, 'utf8'), '', 'nothing was written to the 0644 file');

  // The directory half of the same contract: a chmod that does not take effect disables writing.
  const dirRoot = path.join(root, 'dir-mode');
  const dirFake = Object.create(fs);
  dirFake.mkdirSync = (target, options) =>
    fs.mkdirSync(target, { ...options, mode: 0o755 });
  dirFake.chmodSync = () => {}; // reports success without changing the mode
  const dirLog = createAuditLog({ directory: dirRoot, fileSystem: dirFake });
  assert.equal(dirLog.enabled, false);
  assert.match(dirLog.disabledReason, /0700/);
  assert.equal(dirLog.record('secret', {}), false);
  assert.deepEqual(fs.readdirSync(dirRoot), [], 'no day file was created');
});

test('createAuditLog refuses a FIFO at the daily path without blocking', (t) => {
  const root = makeTempDir(t);
  const directory = path.join(root, 'audit');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fifo = path.join(directory, '2026-06-07.jsonl');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  if (made.status !== 0) {
    t.skip('mkfifo is not available on this platform');
    return;
  }

  const log = createAuditLog({ directory, clock: () => new Date('2026-06-07T00:00:00.000Z') });
  assert.equal(log.record('leak', { apiKey: 'LEAKME' }), false);
  assert.equal(log.enabled, false);
  assert.match(log.disabledReason, /regular file/);
  assert.equal(fs.lstatSync(fifo).isFIFO(), true, 'the FIFO was not replaced');
});

test('createAuditLog replaces an oversized record with a truncation marker', (t) => {
  const root = makeTempDir(t);
  const directory = path.join(root, 'audit');
  const log = createAuditLog({ directory });
  log.record('huge', { blob: 'z'.repeat(MAX_LINE_CHARS + 1000) });
  log.record('after', { ok: true });
  log.close();

  const records = allRecords(directory);
  assert.equal(records.length, 2);
  assert.equal(records[0].event, 'huge');
  assert.equal(records[0].truncated, true);
  assert.ok(records[0].originalChars > MAX_LINE_CHARS);
  assert.equal(records[1].event, 'after');
  assert.ok(fs.statSync(jsonlFiles(directory)[0]).size < MAX_LINE_CHARS + 500);
});

test('createAuditLog degrades one unserializable record instead of disabling logging', (t) => {
  const directory = path.join(makeTempDir(t), 'audit');
  const log = createAuditLog({ directory });

  // A raw BigInt payload makes JSON.stringify throw. The writer must record the
  // failure and keep logging, not go dark for the rest of the process.
  assert.equal(log.record('bad', { big: 1n }), true);
  assert.equal(log.enabled, true);
  assert.equal(log.record('good', { ok: true }), true);
  log.close();

  const records = allRecords(directory);
  assert.equal(records.length, 2);
  assert.equal(records[0].event, 'bad');
  assert.ok(records[0].serializationError.includes('BigInt'));
  assert.equal(records[1].event, 'good');
  assert.equal(records[1].ok, true);
});

test('createAuditLog is a no-op when the audit directory cannot be created', (t) => {
  const root = makeTempDir(t);
  const blocker = path.join(root, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');

  const log = createAuditLog({ directory: path.join(blocker, 'audit') });
  assert.equal(log.enabled, false);
  assert.ok(log.disabledReason);
  assert.equal(log.record('anything', { a: 1 }), false);
  log.close();
  assert.equal(log.record('again', {}), false);
});

test('resolveAuditDir honors the env override and defaults to the home directory', () => {
  assert.equal(resolveAuditDir({}), defaultAuditDir());
  assert.equal(resolveAuditDir({ [AUDIT_DIR_ENV]: '' }), defaultAuditDir());
  assert.equal(resolveAuditDir({ [AUDIT_DIR_ENV]: '   ' }), defaultAuditDir());
  assert.equal(resolveAuditDir({ [AUDIT_DIR_ENV]: '/custom/audit' }), '/custom/audit');
  assert.equal(resolveAuditDir({ [AUDIT_DIR_ENV]: 'relative/audit' }), path.resolve('relative/audit'));
  assert.equal(
    defaultAuditDir(),
    path.join(os.homedir(), '.local/share/opencode-workflow/audit'),
  );
});

test('BoundedCallMap evicts the oldest entries at its limit', () => {
  const map = new BoundedCallMap(3);
  map.set('a', { id: 'a' }).set('b', { id: 'b' }).set('c', { id: 'c' });
  assert.equal(map.size, 3);
  map.set('d', { id: 'd' });
  assert.equal(map.size, 3);
  assert.equal(map.get('a'), undefined, 'oldest entry evicted');
  assert.deepEqual(map.take('b'), { id: 'b' });
  assert.equal(map.size, 2);
  assert.equal(map.get('b'), undefined);
  map.clear();
  assert.equal(map.size, 0);
  assert.equal(MAX_PENDING_CALLS, 2000);
});

// --- mocked plugin lifecycle ------------------------------------------------------

const SCRIPTED_EVENTS = [
  { id: 'evt_1', type: 'session.execution.started', data: { sessionID: 'ses_1' } },
  {
    id: 'evt_2',
    type: 'permission.asked',
    data: {
      id: 'per_1',
      sessionID: 'ses_1',
      action: 'bash',
      resources: ['bash: rm -rf /tmp/x', 'openai: sk-or-v1-LEAKLEAKLEAK'],
      source: { type: 'tool', id: 'call_1', messageID: 'msg_1' },
      message: 'Approve: Authorization: Bearer abcdefghijklmnop',
      metadata: { password: 'hunter2', path: '/tmp/x' },
    },
  },
  {
    id: 'evt_3',
    type: 'session.usage.updated',
    data: { sessionID: 'ses_1', cost: 0.25, tokens: { input: 10, output: 20 } },
  },
  {
    id: 'evt_4',
    type: 'session.compaction.started',
    data: { sessionID: 'ses_1', reason: 'auto', inputID: 'msg_1' },
  },
  {
    id: 'evt_5',
    type: 'session.compaction.delta',
    data: { sessionID: 'ses_1', text: 'x'.repeat(10000) },
  },
  {
    id: 'evt_6',
    type: 'session.compaction.ended',
    data: {
      sessionID: 'ses_1',
      reason: 'auto',
      text: `summary OPENROUTER_API_KEY=sk-or-v1-LEAKLEAKLEAK`,
      tokens: { input: 100, output: 50 },
      cost: 0.1,
    },
  },
  {
    id: 'evt_7',
    type: 'session.compaction.failed',
    data: { sessionID: 'ses_1', reason: 'auto', error: new Error('compaction sk-or-v1-LEAKLEAKLEAK') },
  },
  {
    id: 'evt_8',
    type: 'permission.replied',
    data: { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' },
  },
  {
    id: 'evt_9',
    type: 'session.idle',
    data: {
      sessionID: 'ses_1',
      background: [
        { kind: 'shell', sessionID: 'ses_1', shellID: 'sh_1', command: 'curl -H "Authorization: Bearer abcdefghijklmnop"' },
      ],
    },
  },
  {
    id: 'evt_10',
    type: 'session.execution.failed',
    data: { sessionID: 'ses_1', error: new Error('provider failed sk-or-v1-LEAKLEAKLEAK') },
  },
  {
    id: 'evt_11',
    type: 'session.execution.interrupted',
    data: { sessionID: 'ses_1', reason: 'user' },
  },
  { id: 'evt_12', type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } },
];

test('plugin loads, records every hook and event, then cleans up idempotently', async (t) => {
  const auditDir = path.join(makeTempDir(t), 'audit');
  useAuditDir(t, auditDir);
  const mock = createMockContext({ events: SCRIPTED_EVENTS });

  assert.equal(auditPlugin.id, PLUGIN_ID);
  assert.equal(auditPlugin.id, 'opencode-workflow-audit');
  assert.equal(typeof auditPlugin.setup, 'function');

  const cleanup = await auditPlugin.setup(mock.ctx);
  assert.equal(typeof cleanup, 'function');
  assert.equal(mock.registrations.length, 7);
  assert.deepEqual(
    mock.registrations.map((registration) => registration.key).sort(),
    [
      'permission.evaluate',
      'session.context',
      'session.experimental.idle',
      'session.prompt',
      'shell.create.before',
      'tool.execute.after',
      'tool.execute.before',
    ],
  );

  // plugin.loaded is written synchronously before setup returns.
  const loaded = allRecords(auditDir).find((record) => record.event === 'plugin.loaded');
  assert.ok(loaded, 'plugin.loaded record missing');
  assert.equal(loaded.plugin, PLUGIN_ID);
  assert.equal(loaded.app.version, '2.3.2');
  assert.equal(loaded.location.directory, '/tmp/project');
  assert.equal(loaded.location.workspaceID, null);
  assert.equal(loaded.auditDir, auditDir);
  assert.equal(loaded.loggingEnabled, true);

  // (b) session.prompt
  await mock.call('session.prompt', {
    sessionID: 'ses_1',
    messageID: 'msg_1',
    delivery: 'queue',
    prompt: {
      text: 'please use sk-or-v1-LEAKLEAKLEAK and Bearer abcdefghijklmnop to finish',
      files: [{ uri: 'file:///tmp/secret.env', name: 'secret.env' }],
      agents: [{ name: 'build' }, { name: 'worker' }],
      skills: [{ id: 'pdf' }, { id: 'browser' }],
    },
    metadata: { apiKey: 'LEAKMETOO' },
  });

  // (c) tool before/after, including timing and result summary.
  await mock.call('tool.execute.before', {
    tool: 'read',
    id: 'call_a',
    sessionID: 'ses_1',
    agent: 'build',
    messageID: 'msg_1',
    input: {
      filePath: '/tmp/x',
      content: 'x'.repeat(10000),
      apiKey: 'LEAKMETOO',
      nested: { headers: { Authorization: 'Bearer abcdefghijklmnop' } },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await mock.call('tool.execute.after', {
    tool: 'read',
    id: 'call_a',
    sessionID: 'ses_1',
    agent: 'build',
    messageID: 'msg_1',
    status: 'completed',
    input: { filePath: '/tmp/x' },
    result: {
      content: [
        { type: 'text', text: `body ${'y'.repeat(10000)}` },
        { type: 'file', uri: 'file:///tmp/a.png', mime: 'image/png', name: 'a.png' },
      ],
      metadata: { token: 'LEAKMETOO', count: 1 },
    },
  });

  // (c) an execute.after whose before was never seen still logs, with durationMs null.
  await mock.call('tool.execute.after', {
    tool: 'bash',
    id: 'call_unknown',
    sessionID: 'ses_1',
    agent: 'build',
    messageID: 'msg_2',
    status: 'error',
    input: { command: 'echo hi' },
    error: new Error('tool failed sk-or-v1-LEAKLEAKLEAK'),
  });

  // (d) permission.evaluate
  await mock.call('permission.evaluate', {
    sessionID: 'ses_1',
    agent: 'build',
    action: 'bash',
    resources: ['bash: rm -rf /tmp/x', 'openai: sk-or-v1-LEAKLEAKLEAK'],
    effect: 'ask',
    source: { type: 'tool', id: 'call_1', messageID: 'msg_1' },
    message: 'needs approval',
  });

  // (e) shell.create.before: env values must never be read or logged.
  await mock.call('shell.create.before', {
    command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://user:hunter2@example.com',
    cwd: '/tmp/project',
    timeout: 30000,
    shell: '/bin/bash',
    env: {
      PATH: '/usr/bin',
      OPENROUTER_API_KEY: 'sk-or-v1-LEAKLEAKLEAK',
      DB_PASSWORD: 'hunter2',
    },
  });

  // (f) wait for the scripted event stream to drain through the subscriber.
  await waitFor(
    () => allRecords(auditDir).some((record) => record.event === 'session.execution.succeeded'),
    { message: 'event subscriber did not record session.execution.succeeded' },
  );

  const records = allRecords(auditDir);
  const byEvent = (name) => records.filter((record) => record.event === name);

  // Every event type captured.
  for (const type of EVENT_TYPES) {
    assert.equal(byEvent(type).length, 1, `${type} should be recorded exactly once`);
  }
  assert.equal(EVENT_TYPES.length, 12);

  // Prompt preview and attachments.
  const prompt = byEvent('session.prompt')[0];
  assert.equal(prompt.sessionID, 'ses_1');
  assert.equal(prompt.messageID, 'msg_1');
  assert.equal(prompt.delivery, 'queue');
  assert.equal(
    prompt.prompt.chars,
    'please use sk-or-v1-LEAKLEAKLEAK and Bearer abcdefghijklmnop to finish'.length,
  );
  assert.ok(prompt.prompt.preview.includes('[REDACTED]'));
  assert.ok(!prompt.prompt.preview.includes('LEAKLEAKLEAK'));
  assert.deepEqual(prompt.agents, ['build', 'worker']);
  assert.deepEqual(prompt.skills, ['pdf', 'browser']);
  assert.equal(prompt.files.count, 1);
  assert.equal(prompt.files.items[0].uri, 'file:///tmp/secret.env');
  assert.equal(prompt.metadata.apiKey, REDACTED);

  // Tool calls.
  const toolBefore = byEvent('tool.before')[0];
  assert.equal(toolBefore.tool, 'read');
  assert.equal(toolBefore.callId, 'call_a');
  assert.equal(toolBefore.input.apiKey, REDACTED);
  assert.equal(toolBefore.input.nested.headers.Authorization, REDACTED);
  assert.ok(toolBefore.input.content.includes('[truncated'));
  assert.ok(toolBefore.input.content.length < 10000);

  const completed = byEvent('tool.after').find((record) => record.callId === 'call_a');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.timing, 'measured');
  assert.ok(completed.durationMs >= 4, `durationMs ${completed.durationMs} should reflect the 5ms gap`);
  assert.equal(completed.result.content.parts[0].chars, 10005);
  assert.equal(completed.result.content.parts[1].uri, 'file:///tmp/a.png');
  assert.equal(completed.result.metadata.token, REDACTED);

  const failed = byEvent('tool.after').find((record) => record.callId === 'call_unknown');
  assert.equal(failed.status, 'error');
  assert.equal(failed.durationMs, null);
  assert.equal(failed.timing, 'unknown');
  assert.ok(failed.error.message.includes('[REDACTED]'));

  // Permission evaluation.
  const permission = byEvent('permission.evaluate')[0];
  assert.equal(permission.action, 'bash');
  assert.equal(permission.effect, 'ask');
  assert.equal(permission.agent, 'build');
  assert.deepEqual(permission.source, { type: 'tool', id: 'call_1', messageID: 'msg_1' });
  assert.equal(permission.message, 'needs approval');

  // Shell command redaction; env values absent.
  const shell = byEvent('shell.before')[0];
  assert.equal(shell.envVarCount, 3);
  assert.equal(shell.cwd, '/tmp/project');
  assert.equal(shell.timeout, 30000);
  assert.ok(shell.command.includes('Bearer [REDACTED]'));
  assert.ok(shell.command.includes('user:[REDACTED]@'));
  assert.ok(!('env' in shell));

  // Event payloads.
  assert.deepEqual(byEvent('session.usage.updated')[0].tokens, { input: 10, output: 20 });
  assert.equal(byEvent('session.usage.updated')[0].cost, 0.25);
  assert.equal(byEvent('session.compaction.delta')[0].chars, 10000);
  const compaction = byEvent('session.compaction.ended')[0];
  assert.equal(compaction.reason, 'auto');
  assert.equal(compaction.text.chars, 'summary OPENROUTER_API_KEY=sk-or-v1-LEAKLEAKLEAK'.length);
  assert.ok(compaction.text.preview.includes('OPENROUTER_API_KEY=[REDACTED]'));
  assert.ok(!JSON.stringify(compaction).includes('LEAKLEAKLEAK'));
  assert.ok(byEvent('session.compaction.failed')[0].error.message.includes('[REDACTED]'));
  assert.equal(byEvent('permission.replied')[0].reply, 'once');
  assert.equal(byEvent('permission.replied')[0].requestID, 'per_1');
  assert.ok(byEvent('permission.asked')[0].metadata.password === REDACTED);
  assert.equal(byEvent('session.execution.interrupted')[0].reason, 'user');
  assert.ok(byEvent('session.execution.failed')[0].error.message.includes('[REDACTED]'));
  assert.ok(byEvent('session.idle')[0].background[0].command.includes('Bearer [REDACTED]'));

  // No raw secret anywhere in the audit log.
  const rawAudit = fs.readFileSync(jsonlFiles(auditDir)[0], 'utf8');
  for (const secret of [
    'LEAKLEAKLEAK',
    'LEAKMETOO',
    'abcdefghijklmnop',
    'hunter2',
    'sk-or-v1-',
    'ghp_',
  ]) {
    assert.ok(!rawAudit.includes(secret), `${secret} leaked into the audit log`);
  }

  // Cleanup: abort the subscriber, dispose every hook exactly once, idempotent.
  const signal = mock.signals[0].signal;
  assert.equal(signal.aborted, false);
  await cleanup();
  assert.equal(signal.aborted, true);
  assert.equal(mock.streamState.finished, true);
  for (const registration of mock.registrations) {
    assert.equal(registration.disposeCalls, 1, `${registration.key} dispose count`);
  }
  const stopped = allRecords(auditDir).filter((record) => record.event === 'plugin.stopped');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].plugin, PLUGIN_ID);
  assert.equal(stopped[0].hooksDisposed, 7);
  assert.equal(stopped[0].eventSubscriberAborted, true);
  assert.equal(stopped[0].eventSubscriberEnded, true);

  const recordsBeforeSecondCleanup = allRecords(auditDir).length;
  await cleanup();
  await cleanup();
  for (const registration of mock.registrations) {
    assert.equal(registration.disposeCalls, 1, `${registration.key} disposed again`);
  }
  assert.equal(
    allRecords(auditDir).filter((record) => record.event === 'plugin.stopped').length,
    1,
    'plugin.stopped must be written once',
  );
  assert.equal(allRecords(auditDir).length, recordsBeforeSecondCleanup);
});

test('plugin timing table is bounded at MAX_PENDING_CALLS entries', async (t) => {
  const auditDir = path.join(makeTempDir(t), 'audit');
  useAuditDir(t, auditDir);
  const mock = createMockContext({ events: [] });
  const cleanup = await auditPlugin.setup(mock.ctx);

  await mock.call('tool.execute.before', {
    tool: 'read',
    id: 'oldest',
    sessionID: 'ses_1',
    agent: 'build',
    messageID: 'msg_1',
    input: {},
  });
  for (let index = 0; index < MAX_PENDING_CALLS; index += 1) {
    await mock.call('tool.execute.before', {
      tool: 'read',
      id: `call_${index}`,
      sessionID: 'ses_1',
      agent: 'build',
      messageID: 'msg_1',
      input: {},
    });
  }

  // The oldest timing was evicted, so its after-hook cannot compute a duration.
  await mock.call('tool.execute.after', {
    tool: 'read',
    id: 'oldest',
    sessionID: 'ses_1',
    agent: 'build',
    messageID: 'msg_1',
    status: 'completed',
    input: {},
    result: {},
  });
  await mock.call('tool.execute.after', {
    tool: 'read',
    id: `call_${MAX_PENDING_CALLS - 1}`,
    sessionID: 'ses_1',
    agent: 'build',
    messageID: 'msg_1',
    status: 'completed',
    input: {},
    result: {},
  });

  const afters = allRecords(auditDir).filter((record) => record.event === 'tool.after');
  assert.equal(afters.find((record) => record.callId === 'oldest').durationMs, null);
  assert.equal(afters.find((record) => record.callId === 'oldest').timing, 'unknown');
  assert.equal(
    typeof afters.find((record) => record.callId === `call_${MAX_PENDING_CALLS - 1}`).durationMs,
    'number',
  );

  await cleanup();
});

test('plugin tolerates an unwritable audit directory and hostile hook input', async (t) => {
  const root = makeTempDir(t);
  const blocker = path.join(root, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  useAuditDir(t, path.join(blocker, 'audit'));

  const mock = createMockContext({ events: [] });
  const cleanup = await auditPlugin.setup(mock.ctx);
  assert.equal(typeof cleanup, 'function');

  // Hooks still resolve, even with payloads that throw when read.
  const hostile = {
    get input() {
      throw new Error('hostile input');
    },
    id: 'call_hostile',
    sessionID: 'ses_1',
  };
  await mock.call('session.prompt', {
    get prompt() {
      throw new Error('hostile prompt');
    },
    sessionID: 'ses_1',
  });
  await mock.call('tool.execute.before', hostile);
  await mock.call('tool.execute.after', {
    id: 'call_hostile',
    sessionID: 'ses_1',
    status: 'completed',
    get input() {
      throw new Error('hostile input');
    },
  });
  await mock.call('permission.evaluate', hostile);
  await mock.call('shell.create.before', {
    get env() {
      throw new Error('hostile env');
    },
    command: 'echo hi',
    cwd: '/tmp',
    timeout: 1,
    shell: '/bin/sh',
  });

  await cleanup();
  assert.deepEqual(fs.readdirSync(root), ['not-a-directory']);
  assert.equal(fs.existsSync(path.join(blocker, 'audit')), false);
});

test('cleanup bounds a hanging dispose() with a per-dispose timeout', { timeout: 15_000 }, async (t) => {
  // Regression (reviewer Part A): cleanup awaited registration.dispose() with no bound, so a
  // host implementation that never settles could hang OpenCode's teardown forever.
  const auditDir = path.join(makeTempDir(t), 'audit');
  useAuditDir(t, auditDir);
  const mock = createMockContext({ events: [] });
  const cleanup = await auditPlugin.setup(mock.ctx);

  mock.registrations[0].dispose = () => new Promise(() => {}); // never settles
  const startedAt = Date.now();
  await cleanup();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed >= DISPOSE_TIMEOUT_MS - 50, `cleanup returned too early (${elapsed}ms)`);
  assert.ok(elapsed < DISPOSE_TIMEOUT_MS + 3_000, `cleanup was not bounded (${elapsed}ms)`);

  const timeoutRecord = allRecords(auditDir).find(
    (record) => record.event === 'plugin.error' && record.where === 'cleanup.dispose.timeout',
  );
  assert.ok(timeoutRecord, 'a dispose timeout must be recorded');
  assert.ok(timeoutRecord.message.includes(String(DISPOSE_TIMEOUT_MS)));

  // The remaining hooks are still disposed and teardown still completes exactly once.
  for (const registration of mock.registrations.slice(1)) {
    assert.equal(registration.disposeCalls, 1, `${registration.key} dispose count`);
  }
  assert.equal(
    allRecords(auditDir).filter((record) => record.event === 'plugin.stopped').length,
    1,
  );
});

test('plugin survives an event stream that fails immediately and a throwing dispose', async (t) => {
  const auditDir = path.join(makeTempDir(t), 'audit');
  useAuditDir(t, auditDir);
  const mock = createMockContext({
    subscribeImpl() {
      throw new Error('event stream unavailable');
    },
  });

  const cleanup = await auditPlugin.setup(mock.ctx);
  const errorRecord = await waitFor(
    () => allRecords(auditDir).find((record) => record.event === 'plugin.error' && record.where === 'event.subscriber'),
    { message: 'subscriber failure was not recorded' },
  );
  assert.ok(errorRecord.message.includes('event stream unavailable'));

  // A dispose failure must not stop the remaining hooks from being disposed.
  mock.registrations[0].dispose = async () => {
    throw new Error('dispose failed');
  };
  await cleanup(); // must not reject

  const disposeError = allRecords(auditDir).find(
    (record) => record.event === 'plugin.error' && record.where === 'cleanup.dispose',
  );
  assert.ok(disposeError);
  assert.ok(disposeError.message.includes('dispose failed'));
  for (const registration of mock.registrations.slice(1)) {
    assert.equal(registration.disposeCalls, 1);
  }
  assert.equal(
    allRecords(auditDir).filter((record) => record.event === 'plugin.stopped').length,
    1,
  );
});

// --- real OpenCode smoke test -----------------------------------------------------

test(
  'real OpenCode v2 binary loads the plugin with zero load warnings and writes plugin.loaded',
  { timeout: 180_000 },
  (t) => {
    if (!fs.existsSync(OPENCODE_BIN)) {
      t.skip(`${OPENCODE_BIN} not installed`);
      return;
    }

    const version = spawnSync(OPENCODE_BIN, ['--version'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(version.status, 0, version.stderr);
    const versionMatch = version.stdout.trim().match(/^opencode v?(2\.\d+\.\d+)$/);
    assert.ok(versionMatch, `expected OpenCode v2.x, got ${version.stdout.trim()}`);
    const installedVersion = versionMatch[1];

    const root = makeTempDir(t, 'ocw-opencode-smoke-');
    const home = path.join(root, 'home');
    const configHome = path.join(root, 'config');
    const dataHome = path.join(root, 'data');
    const stateHome = path.join(root, 'state');
    const cacheHome = path.join(root, 'cache');
    const auditDir = path.join(root, 'audit');
    const configDir = path.join(configHome, 'opencode');
    for (const dir of [home, configDir, dataHome, stateHome, cacheHome]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.copyFileSync(
      path.join(REPO_ROOT, 'config/opencode.jsonc'),
      path.join(configDir, 'opencode.jsonc'),
    );

    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: stateHome,
      XDG_CACHE_HOME: cacheHome,
      [AUDIT_DIR_ENV]: auditDir,
      // Never let the smoke test inherit a live service or model override.
    };
    delete env.OPENCODE_SERVER;
    delete env.OPENCODE_MODEL;

    const logFile = path.join(dataHome, 'opencode', 'log', 'opencode.log');
    const run = (args) => {
      const result = spawnSync(OPENCODE_BIN, ['--standalone', ...args], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 90_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      assert.equal(
        result.status,
        0,
        `opencode ${args.join(' ')} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.ok(fs.existsSync(logFile), 'opencode.log was not created');
      const log = fs.readFileSync(logFile, 'utf8');
      assert.ok(
        !/failed to load plugin/i.test(log),
        `plugin load warning in log:\n${log
          .split('\n')
          .filter((line) => /plugin/i.test(line))
          .join('\n')}`,
      );
      return { result, log };
    };

    // Stage 1: `debug config` under an isolated XDG home, as required by the task.
    // It must exit cleanly and produce no plugin-load warning. (In 2.3.2 it may or may
    // not get as far as probing the plugin module before the private server shuts
    // down, so loading is asserted on the next, deterministic command instead.)
    const configRun = run(['debug', 'config']);
    const parsedConfig = JSON.parse(configRun.result.stdout);
    assert.ok(
      parsedConfig.some((source) => JSON.stringify(source).includes('audit-logger')),
      'temp config does not reference the audit-logger plugin',
    );

    // Stage 2: OpenCode 2.3.2 resolves the plugin module during config resolution but
    // defers Plugin.setup() until a command that activates the plugin host. `debug
    // agents` does that deterministically and contacts no model, so it is the
    // zero-cost way to prove the real runtime loads the entrypoint, executes setup and
    // writes the JSONL record.
    const agentsRun = run(['debug', 'agents']);
    assert.ok(agentsRun.result.stdout.length > 0, 'debug agents produced no output');
    assert.match(agentsRun.log, /msg="loading plugin"/);
    assert.match(agentsRun.log, /audit-logger\/index\.js/);

    const files = jsonlFiles(auditDir);
    assert.ok(files.length >= 1, `no JSONL audit file created in ${auditDir}`);
    const records = allRecords(auditDir);
    const loaded = records.find((record) => record.event === 'plugin.loaded');
    assert.ok(loaded, 'real OpenCode run did not write plugin.loaded');
    assert.equal(loaded.plugin, PLUGIN_ID);
    assert.equal(loaded.app.version, installedVersion);
    assert.equal(loaded.auditDir, auditDir);
    assert.equal(loaded.loggingEnabled, true);
    assert.ok(path.isAbsolute(loaded.location.directory), 'location.directory should be absolute');
    assert.ok(typeof loaded.pid === 'number' && loaded.pid > 0);

    assert.equal(fs.statSync(auditDir).mode & 0o777, 0o700, 'audit dir mode');
    assert.equal(fs.statSync(files[0]).mode & 0o777, 0o600, 'audit file mode');
    assert.match(path.basename(files[0]), /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  },
);
