/**
 * Structured shell & secret permission evaluator for OpenCode `permission.hook("evaluate")`.
 *
 * Replaces 120+ brittle static shell glob rules in `opencode.jsonc` with real shell
 * lexing, segment splitting, subshell/heredoc/wrapper unwrapping, and semantic classification:
 *
 *   - NEVER weakens `effect === "deny"` (read-only agents stay strictly read-only).
 *   - Escalates `allow -> ask` on real `.env`/`.env.local`/`production.env`/private keys
 *     and destructive local or remote/infra/DB mutations (even if a stale saved `"always"`
 *     rule exists in `opencode.db`).
 *   - Overrides the static fail-closed `*.env*` shell fallback `ask -> allow` ONLY when
 *     EVERY `.env` occurrence across the raw command string is accounted for by a parsed
 *     safe template (`.env.example`, `.env.sample`, `.env.template`, ...) or safe code
 *     identifier (`process.env`, `import.meta.env`, ...) AND the entire command parsed
 *     cleanly with zero secret, destructive, or remote hits.
 *   - Fails closed on parse errors, unclosed quotes, oversized commands, or deep nesting.
 */

export const MAX_COMMAND_CHARS = 65_536;
export const MAX_PARSE_DEPTH = 6;
export const MAX_SEGMENTS = 128;

const SHELL_ACTIONS = new Set(['shell', 'bash']);

/** Template suffixes on `.env.*` that are safe documentation templates, not live secrets. */
const SAFE_ENV_TEMPLATE_SUFFIXES = new Set([
  'example',
  'sample',
  'template',
  'dist',
  'defaults',
  'default',
  'schema',
  'types',
]);

/**
 * Code object prefixes before `.env` (e.g. `process.env`, `import.meta.env`) that appear
 * inside grep patterns or inline snippets and are NOT filesystem paths to `*.env` files.
 */
const SAFE_CODE_ENV_PREFIXES = new Set([
  'process',
  'meta',
  'import.meta',
  'deno',
  'bun',
  'os',
  'std',
  'global',
  'globalthis',
  'this',
  'self',
  'ctx',
  'context',
  'req',
  'res',
  'app',
  'config',
  'cfg',
  'opts',
  'options',
  'state',
  'window',
  'runtime',
  'client',
  'server',
  'next',
  'vite',
  'c',
  'e',
]);

/** Shell keywords / grouping words that can precede an inner command in a segment. */
const CONTROL_PREFIX_WORDS = new Set([
  '!',
  'if',
  'then',
  'elif',
  'else',
  'do',
  'while',
  'until',
  'time',
  'coproc',
]);

/** Shell keywords that terminate blocks cleanly when trailing or standalone. */
const CONTROL_TERMINATOR_WORDS = new Set(['fi', 'done', 'esac']);

/** Commands that take a filename argument directly (so even `config.env` is a file path). */
const FILE_READ_WRITE_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'nl',
  'sed',
  'awk',
  'cp',
  'mv',
  'rm',
  'ln',
  'touch',
  'chmod',
  'chown',
  'source',
  '.',
  'tee',
  'vi',
  'vim',
  'nano',
  'ed',
  'truncate',
  'shred',
  'base64',
  'xxd',
  'hexdump',
  'od',
  'strings',
  'file',
  'wc',
  'sort',
  'cut',
  'tr',
  'diff',
  'cmp',
  'comm',
  'scp',
  'rsync',
  'dotenv',
]);

const INLINE_SCRIPT_COMMANDS = new Set([
  'node',
  'nodejs',
  'bun',
  'deno',
  'python',
  'python3',
  'pypy3',
  'ruby',
  'perl',
  'php',
  'lua',
]);

const SHELL_LAUNCHERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);
const TRANSPARENT_WRAPPERS = new Set(['command', 'builtin', 'nohup', 'time', 'exec']);

const SECRET_FILE_BASENAMES = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_xmss',
  'credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.my.cnf',
]);

const MUTATING_SYSTEMCTL_VERBS = new Set([
  'start',
  'stop',
  'restart',
  'reload',
  'try-restart',
  'reload-or-restart',
  'try-reload-or-restart',
  'enable',
  'disable',
  'reenable',
  'mask',
  'unmask',
  'daemon-reload',
  'daemon-reexec',
  'edit',
  'set-property',
  'kill',
  'reset-failed',
  'isolate',
  'reboot',
  'poweroff',
  'halt',
  'suspend',
  'hibernate',
]);

const MUTATING_DOCKER_SUBCOMMANDS = new Set([
  'rm',
  'rmi',
  'push',
  'stop',
  'kill',
  'restart',
  'pause',
  'unpause',
  'prune',
  'login',
  'logout',
  'exec',
  'run',
  'deploy',
]);

const MUTATING_COMPOSE_SUBCOMMANDS = new Set([
  'up',
  'down',
  'rm',
  'restart',
  'stop',
  'kill',
  'pull',
  'push',
  'build',
  'run',
  'exec',
  'create',
  'start',
]);

const MUTATING_KUBECTL_SUBCOMMANDS = new Set([
  'delete',
  'apply',
  'patch',
  'replace',
  'edit',
  'scale',
  'rollout',
  'drain',
  'cordon',
  'uncordon',
  'taint',
  'create',
  'set',
  'autoscale',
  'label',
  'annotate',
]);

const MUTATING_TERRAFORM_SUBCOMMANDS = new Set([
  'apply',
  'destroy',
  'import',
  'state',
  'taint',
  'untaint',
  'force-unlock',
]);

const MUTATING_HELM_SUBCOMMANDS = new Set([
  'install',
  'upgrade',
  'uninstall',
  'delete',
  'rollback',
]);

const DB_CLI_COMMANDS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'mongosh', 'mongo', 'redis-cli']);
const CLOUD_CLI_COMMANDS = new Set(['gcloud', 'aws', 'az']);
const REMOTE_TRANSFER_COMMANDS = new Set(['ssh', 'scp', 'rsync', 'sftp']);
const DESTRUCTIVE_SYSTEM_COMMANDS = new Set([
  'kill',
  'pkill',
  'killall',
  'chown',
  'dd',
  'fdisk',
  'parted',
  'shutdown',
  'reboot',
  'poweroff',
  'halt',
]);

function baseCommandName(token) {
  if (typeof token !== 'string' || token.length === 0) return '';
  const cleaned = token.replace(/^['"]|['"]$/g, '');
  const slash = cleaned.lastIndexOf('/');
  return (slash >= 0 ? cleaned.slice(slash + 1) : cleaned).toLowerCase();
}

function isEnvAssignmentToken(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function countOccurrences(text, needle) {
  if (typeof text !== 'string' || !needle) return 0;
  const hay = text.toLowerCase();
  const sub = needle.toLowerCase();
  let count = 0;
  let pos = 0;
  while ((pos = hay.indexOf(sub, pos)) !== -1) {
    count += 1;
    pos += sub.length;
  }
  return count;
}

/**
 * Strip surrounding shell quotes / trailing punctuation from a path-like candidate and test
 * whether it refers to a real `.env` secret file (vs `.env.example` or `process.env`).
 */
export function classifyEnvReference(rawToken, { isFileContext = false, isRedirection = false } = {}) {
  if (typeof rawToken !== 'string' || rawToken.length === 0) return null;
  const cleaned = rawToken
    .replace(/^['"`(]+|[)'"`,;:]+$/g, '')
    .replace(/\\/g, '/');
  if (!cleaned) return null;

  // Handle flag=value forms such as `--env-file=.env.local`, `--arg-file=.env`, `ENV_FILE=.env`
  const eqIndex = cleaned.indexOf('=');
  if (eqIndex > 0) {
    const left = cleaned.slice(0, eqIndex).toLowerCase();
    const right = cleaned.slice(eqIndex + 1);
    if (
      left.startsWith('--') ||
      left.startsWith('-') ||
      left.endsWith('_file') ||
      left.endsWith('file') ||
      left.endsWith('_path') ||
      left.endsWith('path')
    ) {
      return classifyEnvReference(right, { isFileContext: true, isRedirection: false });
    }
    if (right.toLowerCase().includes('.env')) {
      return classifyEnvReference(right, { isFileContext: false, isRedirection: false });
    }
    return null;
  }

  const lower = cleaned.toLowerCase();
  if (!lower.includes('.env')) return null;

  const hasPathSep = lower.includes('/');
  const base = hasPathSep ? lower.slice(lower.lastIndexOf('/') + 1) : lower;

  // 1. Exact `.env`
  if (base === '.env') {
    return { kind: 'env', target: cleaned, reason: `accesses secret file ${cleaned}` };
  }

  // 2. `.env.<suffix>` (e.g. `.env.local`, `.env.production`, `.env.example`)
  if (base.startsWith('.env.')) {
    const suffix = base.slice('.env.'.length);
    if (SAFE_ENV_TEMPLATE_SUFFIXES.has(suffix)) return null;
    return { kind: 'env', target: cleaned, reason: `accesses secret file ${cleaned}` };
  }

  // 3. `<prefix>.env` or `<prefix>.env.<suffix>` (e.g. `production.env`, `studio.env`, vs `process.env.FOO`)
  const envMatch = base.match(/^(.+?)\.env(?:\.(.+))?$/);
  if (envMatch) {
    const prefix = envMatch[1];
    const suffix = envMatch[2] ?? '';

    if (suffix && SAFE_ENV_TEMPLATE_SUFFIXES.has(suffix)) return null;

    if (!hasPathSep && !isRedirection && !isFileContext) {
      if (SAFE_CODE_ENV_PREFIXES.has(prefix)) return null;
      const parts = prefix.split(/[|(\s,]+/).filter(Boolean);
      const lastIdent = parts[parts.length - 1] ?? '';
      if (SAFE_CODE_ENV_PREFIXES.has(lastIdent)) return null;
    }

    return { kind: 'env', target: cleaned, reason: `accesses secret file ${cleaned}` };
  }

  // 4. Glob patterns or any other token carrying `.env` (fail closed!)
  if (
    /^\*\.env\*?$|^\.env\*$|^.*\/\.env\*$/.test(lower) ||
    /(?:^|[\s/:=])\.env(?:$|[^a-z0-9]|[.][a-z0-9_-]+)/.test(lower)
  ) {
    return { kind: 'env', target: cleaned, reason: `may access secret .env file (${cleaned})` };
  }

  return null;
}

/**
 * Inspect whether a token containing `.env` is explicitly accounted for as a safe template
 * (`.env.example`, `.env.sample`, ...) or safe code identifier (`process.env`, `import.meta.env`).
 * Used to strictly gate `ask -> allow` overrides so no unknown `.env` token can ever slip through.
 */
function countSafeAccountedEnvOccurrences(token, { isFileContext = false, isRedirection = false } = {}) {
  if (typeof token !== 'string') return 0;
  const total = countOccurrences(token, '.env');
  if (total === 0) return 0;
  // Every `.env` inside this token must classify as safe (no hit).
  // Split compound regex/script chunks carefully: if the token contains multiple `.env` occurrences
  // (e.g. a grep pattern or inline JS snippet), inspect every whitespace/quote/pipe-delimited subpiece.
  const pieces = token.split(/[\s'"`|,;(){}[\]]+/).filter((p) => p.toLowerCase().includes('.env'));
  if (pieces.length === 0) return 0;
  let safeCount = 0;
  for (const piece of pieces) {
    if (classifyEnvReference(piece, { isFileContext, isRedirection })) {
      return -1; // At least one real secret reference!
    }
    safeCount += countOccurrences(piece, '.env');
  }
  return safeCount === total ? safeCount : -1;
}

/** Detect references to private keys or credential directories in shell tokens/redirections. */
function classifyOtherSecretReference(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length === 0) return null;
  const cleaned = rawToken.replace(/^['"`]+|['"`]+$/g, '').replace(/\\/g, '/');
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  const base = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower;

  if (SECRET_FILE_BASENAMES.has(base) || /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.|$)/.test(base)) {
    if (base.endsWith('.pub')) return null;
    return { kind: 'secret', target: cleaned, reason: `accesses private key/credential file ${cleaned}` };
  }
  if (base.endsWith('.pem') || base.endsWith('.p12') || base.endsWith('.pfx') || base.endsWith('.jks')) {
    return { kind: 'secret', target: cleaned, reason: `accesses key/certificate file ${cleaned}` };
  }
  if (/(?:^|\/)secrets\/.+/.test(lower)) {
    return { kind: 'secret', target: cleaned, reason: `accesses path inside secrets/ (${cleaned})` };
  }
  if (/(?:^|\/)\.aws\/credentials$/.test(lower) || /(?:^|\/)\.ssh\/(?!known_hosts$|config$|.*\.pub$).+/.test(lower)) {
    return { kind: 'secret', target: cleaned, reason: `accesses sensitive credential path ${cleaned}` };
  }
  if (/(?:^|\/)opencode\/(?:auth|service)\.json$/.test(lower)) {
    return { kind: 'secret', target: cleaned, reason: `accesses OpenCode credential file ${cleaned}` };
  }
  return null;
}

/**
 * Inspect inline script strings (e.g. `python3 -c "..."`, `node -e "..."`, or heredoc body)
 * for quoted references to real `.env` or secret files.
 */
function inspectInlineCodeForSecrets(code) {
  if (typeof code !== 'string' || code.length === 0) return null;
  const literalRegex = /(["'`])((?:\\.|(?!\1)[^\\]){1,400})\1/g;
  let match;
  while ((match = literalRegex.exec(code)) !== null) {
    const literal = match[2];
    const envHit = classifyEnvReference(literal, { isFileContext: true });
    if (envHit) return envHit;
    const secretHit = classifyOtherSecretReference(literal);
    if (secretHit) return secretHit;
  }
  return null;
}

/** Extract `$(...)` and backtick subshells from an unquoted heredoc body. */
function extractSubstitutionsFromText(text) {
  const subs = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\\' && next !== undefined) {
      i += 2;
      continue;
    }
    if (ch === '$' && next === '(') {
      const extracted = extractParenSubshell(text, i + 2);
      if (!extracted.ok) return { ok: false, error: extracted.error, subs };
      subs.push(extracted.body);
      i = extracted.endIndex;
      continue;
    }
    if (ch === '`') {
      const extracted = extractBacktickSubshell(text, i + 1);
      if (!extracted.ok) return { ok: false, error: extracted.error, subs };
      subs.push(extracted.body);
      i = extracted.endIndex;
      continue;
    }
    i += 1;
  }
  return { ok: true, subs };
}

/**
 * Lex a shell command string into top-level command segments separated by `;`, `&&`, `||`,
 * `|`, `&`, `\n`, `(`, `)`, `{`, `}`, while tracking pipe provenance, redirections,
 * heredoc bodies (quoted vs unquoted), comments, and embedded `$(...)` / backtick subshells.
 *
 * Returns `{ ok, error?, segments, subshells, hasComments }`.
 */
export function parseShellSegments(command) {
  if (typeof command !== 'string') {
    return { ok: false, error: 'command is not a string', segments: [], subshells: [], hasComments: false };
  }
  if (command.length > MAX_COMMAND_CHARS) {
    return { ok: false, error: 'command exceeds safe parser length limit', segments: [], subshells: [], hasComments: false };
  }

  const segments = [];
  const subshells = [];
  let currentTokens = [];
  let currentRedirs = [];
  let currentHeredocs = [];
  let currentPipedIn = false;
  let pendingHeredocs = [];
  let expectRedirTarget = false;
  let expectHeredocDelim = false;
  let hasComments = false;

  let token = '';
  let hasToken = false;
  let tokenWasQuoted = false;
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  function pushToken() {
    if (!hasToken) return;
    if (expectHeredocDelim) {
      const stripDash = token.startsWith('-');
      const rawDelim = (stripDash ? token.slice(1) : token).replace(/^['"]|['"]$/g, '');
      if (rawDelim) pendingHeredocs.push({ delim: rawDelim, quoted: tokenWasQuoted });
      expectHeredocDelim = false;
    } else if (expectRedirTarget) {
      currentRedirs.push(token);
      expectRedirTarget = false;
    } else {
      currentTokens.push(token);
    }
    token = '';
    hasToken = false;
    tokenWasQuoted = false;
  }

  function flushSegment(nextPipedIn = false) {
    pushToken();
    if (currentTokens.length > 0 || currentRedirs.length > 0 || currentHeredocs.length > 0) {
      segments.push({
        tokens: currentTokens,
        redirections: currentRedirs,
        heredocs: currentHeredocs,
        pipedIn: currentPipedIn,
      });
    }
    currentTokens = [];
    currentRedirs = [];
    currentHeredocs = [];
    currentPipedIn = nextPipedIn;
    expectRedirTarget = false;
    expectHeredocDelim = false;
  }

  function consumePendingHeredocs() {
    while (pendingHeredocs.length > 0 && i < command.length) {
      const hd = pendingHeredocs.shift();
      const lines = [];
      while (i < command.length) {
        const nl = command.indexOf('\n', i);
        const line = nl === -1 ? command.slice(i) : command.slice(i, nl);
        i = nl === -1 ? command.length : nl + 1;
        if (line.trim() === hd.delim) {
          break;
        }
        lines.push(line);
      }
      const body = lines.join('\n');
      const entry = { body, quoted: hd.quoted };
      if (!hd.quoted) {
        const subs = extractSubstitutionsFromText(body);
        if (!subs.ok) return subs;
        for (const s of subs.subs) subshells.push(s);
      }
      if (segments.length > 0) {
        segments[segments.length - 1].heredocs.push(entry);
      } else {
        currentHeredocs.push(entry);
      }
    }
    return { ok: true };
  }

  while (i < command.length) {
    if (segments.length > MAX_SEGMENTS) {
      return { ok: false, error: 'too many command segments', segments, subshells, hasComments };
    }
    const ch = command[i];
    const next = command[i + 1];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        token += ch;
      }
      hasToken = true;
      i += 1;
      continue;
    }

    if (inDouble) {
      if (ch === '\\' && next !== undefined) {
        token += next;
        hasToken = true;
        i += 2;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        hasToken = true;
        i += 1;
        continue;
      }
      if (ch === '$' && next === '(') {
        const extracted = extractParenSubshell(command, i + 2);
        if (!extracted.ok) return { ok: false, error: extracted.error, segments, subshells, hasComments };
        subshells.push(extracted.body);
        token += `$(${extracted.body})`;
        hasToken = true;
        i = extracted.endIndex;
        continue;
      }
      if (ch === '`') {
        const extracted = extractBacktickSubshell(command, i + 1);
        if (!extracted.ok) return { ok: false, error: extracted.error, segments, subshells, hasComments };
        subshells.push(extracted.body);
        token += `\`${extracted.body}\``;
        hasToken = true;
        i = extracted.endIndex;
        continue;
      }
      token += ch;
      hasToken = true;
      i += 1;
      continue;
    }

    // Outside quotes:
    if (ch === '\\' && next !== undefined) {
      if (next === '\n') {
        i += 2;
        continue;
      }
      if (expectHeredocDelim) tokenWasQuoted = true;
      token += next;
      hasToken = true;
      i += 2;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      tokenWasQuoted = true;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      tokenWasQuoted = true;
      i += 1;
      continue;
    }

    // Shell comment `# ...` only at start of token (unquoted)
    if (ch === '#' && !hasToken) {
      hasComments = true;
      const nl = command.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }

    // Subshell `$(...)`
    if (ch === '$' && next === '(') {
      const extracted = extractParenSubshell(command, i + 2);
      if (!extracted.ok) return { ok: false, error: extracted.error, segments, subshells, hasComments };
      subshells.push(extracted.body);
      token += `$(${extracted.body})`;
      hasToken = true;
      i = extracted.endIndex;
      continue;
    }

    // Backtick subshell
    if (ch === '`') {
      const extracted = extractBacktickSubshell(command, i + 1);
      if (!extracted.ok) return { ok: false, error: extracted.error, segments, subshells, hasComments };
      subshells.push(extracted.body);
      token += `\`${extracted.body}\``;
      hasToken = true;
      i = extracted.endIndex;
      continue;
    }

    // Subshell grouping `(` `)` outside quotes splits command boundaries cleanly
    if (ch === '(' || ch === ')') {
      flushSegment(false);
      i += 1;
      continue;
    }

    // Brace group delimiters `{` / `}` when standing alone as shell tokens
    if ((ch === '{' || ch === '}') && !hasToken) {
      const after = command[i + 1];
      if (after === undefined || /[\s;|\n)&]/.test(after)) {
        flushSegment(false);
        i += 1;
        continue;
      }
    }

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      pushToken();
      i += 1;
      continue;
    }

    // Newline separates commands and starts any pending heredoc body
    if (ch === '\n') {
      flushSegment(false);
      i += 1;
      if (pendingHeredocs.length > 0) {
        const hdRes = consumePendingHeredocs();
        if (!hdRes.ok) return { ok: false, error: hdRes.error, segments, subshells, hasComments };
      }
      continue;
    }

    // Command separators: ;, &&, ||, |, &
    if (ch === ';') {
      flushSegment(false);
      i += 1;
      continue;
    }
    if (ch === '|' || ch === '&') {
      if (ch === '&' && next === '>') {
        pushToken();
        expectRedirTarget = true;
        i += 2;
        continue;
      }
      const isSinglePipe = ch === '|' && next !== '|';
      flushSegment(isSinglePipe);
      i += next === ch ? 2 : 1;
      continue;
    }

    // Redirections: <<, <<-, <<<, >>, >, <, 2>, 1>, 2>&1
    if (ch === '<' || ch === '>') {
      if (hasToken && /^\d+$/.test(token)) {
        token = '';
        hasToken = false;
      } else {
        pushToken();
      }
      if (ch === '<' && next === '<') {
        if (command[i + 2] === '<') {
          i += 3;
          continue;
        }
        expectHeredocDelim = true;
        i += command[i + 2] === '-' ? 3 : 2;
        continue;
      }
      if ((ch === '>' && next === '&') || (ch === '<' && next === '&')) {
        i += 2;
        while (i < command.length && /[0-9-]/.test(command[i])) i += 1;
        continue;
      }
      expectRedirTarget = true;
      i += next === '>' || next === '|' ? 2 : 1;
      continue;
    }

    token += ch;
    hasToken = true;
    i += 1;
  }

  if (inSingle || inDouble) {
    return { ok: false, error: 'unclosed quote in shell command', segments, subshells, hasComments };
  }

  flushSegment(false);
  return { ok: true, segments, subshells, hasComments };
}

function extractParenSubshell(text, startIndex) {
  let depth = 1;
  let i = startIndex;
  let inSingle = false;
  let inDouble = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && next !== undefined) {
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (ch === '\\' && next !== undefined) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i += 1;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return { ok: true, body: text.slice(startIndex, i), endIndex: i + 1 };
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return { ok: false, error: 'unclosed $(...) subshell' };
}

function extractBacktickSubshell(text, startIndex) {
  let i = startIndex;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === '`') {
      return { ok: true, body: text.slice(startIndex, i), endIndex: i + 1 };
    }
    i += 1;
  }
  return { ok: false, error: 'unclosed backtick subshell' };
}

function hasShortFlag(args, flagChar) {
  for (const arg of args) {
    if (arg === '--') break;
    if (arg.startsWith('--') || !arg.startsWith('-') || arg.length < 2) continue;
    if (arg.slice(1).includes(flagChar)) return true;
  }
  return false;
}

function firstPositionalAfterFlags(args, flagsTakingValue = new Set()) {
  let skipNext = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === '--') return { index: i + 1, value: args[i + 1] ?? '' };
    if (arg.startsWith('-')) {
      if (flagsTakingValue.has(arg)) skipNext = true;
      continue;
    }
    return { index: i, value: arg };
  }
  return { index: -1, value: '' };
}

function checkGitCommand(args) {
  const gitGlobalValueFlags = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
  const sub = firstPositionalAfterFlags(args, gitGlobalValueFlags);
  const subcmd = sub.value.toLowerCase();
  const rest = sub.index >= 0 ? args.slice(sub.index + 1) : [];

  if (!subcmd) return null;
  if (subcmd === 'push') return { category: 'remote', reason: 'remote git push requires approval' };
  if (subcmd === 'reset') return { category: 'destructive', reason: 'destructive git reset requires approval' };
  if (subcmd === 'clean') return { category: 'destructive', reason: 'destructive git clean requires approval' };
  if (subcmd === 'rebase') return { category: 'destructive', reason: 'history-rewriting git rebase requires approval' };
  if (subcmd === 'restore') return { category: 'destructive', reason: 'destructive git restore requires approval' };
  if (subcmd === 'filter-branch' || subcmd === 'filter-repo') {
    return { category: 'destructive', reason: `history-rewriting git ${subcmd} requires approval` };
  }
  if (subcmd === 'checkout') {
    if (
      rest.includes('--') ||
      rest.includes('-f') ||
      rest.includes('--force') ||
      rest.includes('.') ||
      rest.includes('./')
    ) {
      return { category: 'destructive', reason: 'destructive git checkout requires approval' };
    }
  }
  if (subcmd === 'commit') {
    if (rest.includes('--amend')) {
      return { category: 'destructive', reason: 'history-rewriting git commit --amend requires approval' };
    }
  }
  if (subcmd === 'stash') {
    const verb = (rest.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
    if (verb === 'drop' || verb === 'clear') {
      return { category: 'destructive', reason: `destructive git stash ${verb} requires approval` };
    }
  }
  if (subcmd === 'worktree') {
    const verb = (rest.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
    if (verb === 'remove' || verb === 'prune') {
      return { category: 'destructive', reason: `destructive git worktree ${verb} requires approval` };
    }
  }
  if (subcmd === 'branch') {
    if (rest.includes('-D') || hasShortFlag(rest, 'D')) {
      return { category: 'destructive', reason: 'force-deleting git branch -D requires approval' };
    }
  }
  if (subcmd === 'remote') {
    const verb = (rest.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
    if (['add', 'remove', 'rm', 'set-url', 'rename', 'prune', 'set-head', 'set-branches'].includes(verb)) {
      return { category: 'remote', reason: `mutating git remote ${verb} requires approval` };
    }
  }
  return null;
}

function checkDockerCommand(args) {
  const dockerGlobalValueFlags = new Set(['-H', '--host', '--context', '--config', '-l', '--log-level']);
  const sub = firstPositionalAfterFlags(args, dockerGlobalValueFlags);
  const subcmd = sub.value.toLowerCase();
  const rest = sub.index >= 0 ? args.slice(sub.index + 1) : [];

  if (!subcmd) return null;
  if (MUTATING_DOCKER_SUBCOMMANDS.has(subcmd)) {
    return { category: 'infra', reason: `mutating docker ${subcmd} requires approval` };
  }
  if (subcmd === 'system' || subcmd === 'volume' || subcmd === 'network' || subcmd === 'container' || subcmd === 'image' || subcmd === 'builder') {
    const verb = (rest.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
    if (verb === 'rm' || verb === 'prune' || verb === 'stop' || verb === 'kill') {
      return { category: 'infra', reason: `mutating docker ${subcmd} ${verb} requires approval` };
    }
  }
  if (subcmd === 'compose') {
    const composeValueFlags = new Set(['-f', '--file', '-p', '--project-name', '--env-file', '--profile', '--project-directory']);
    const verb = firstPositionalAfterFlags(rest, composeValueFlags).value.toLowerCase();
    if (MUTATING_COMPOSE_SUBCOMMANDS.has(verb)) {
      return { category: 'infra', reason: `mutating docker compose ${verb} requires approval` };
    }
  }
  return null;
}

function checkCurlCommand(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') break;

    if (arg === '-X' || arg === '--request') {
      const method = String(args[i + 1] ?? '').toUpperCase();
      if (method && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        return { category: 'remote', reason: `mutating curl -X ${method} requires approval` };
      }
      i += 1;
      continue;
    }
    if (/^--request=(.+)$/i.test(arg)) {
      const method = arg.slice('--request='.length).toUpperCase();
      if (method && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        return { category: 'remote', reason: `mutating curl ${arg} requires approval` };
      }
      continue;
    }

    if (
      arg === '--data' ||
      arg.startsWith('--data-') ||
      arg.startsWith('--data=') ||
      arg === '--json' ||
      arg.startsWith('--json=') ||
      arg === '--form' ||
      arg.startsWith('--form=') ||
      arg === '--form-string' ||
      arg.startsWith('--form-string=') ||
      arg === '--upload-file' ||
      arg.startsWith('--upload-file=')
    ) {
      return { category: 'remote', reason: `mutating curl ${arg} requires approval` };
    }

    // Handle single and combined short flags: `-dfoo`, `-d@f`, `-Ffoo=bar`, `-Tfile`,
    // `-sX POST`, `-sXPOST`, `-sSLd "a=1"`.
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length >= 2) {
      const flags = arg.slice(1);
      for (let j = 0; j < flags.length; j += 1) {
        const flag = flags[j];
        if (flag === 'd' || flag === 'F' || flag === 'T') {
          return { category: 'remote', reason: `mutating curl -${flag} requires approval` };
        }
        if (flag === 'X') {
          const attached = flags.slice(j + 1);
          const method = (attached || String(args[i + 1] ?? '')).toUpperCase();
          if (!attached) i += 1;
          if (method && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            return { category: 'remote', reason: `mutating curl -X ${method} requires approval` };
          }
          break;
        }
      }
    }
  }
  return null;
}

function checkPackageManagerCommand(cmd, args) {
  const sub = firstPositionalAfterFlags(args, new Set(['--prefix', '-C', '--dir'])).value.toLowerCase();
  if (cmd === 'npm') {
    if (sub === 'publish' || sub === 'unpublish' || sub === 'deprecate') {
      return { category: 'remote', reason: `remote npm ${sub} requires approval` };
    }
    if ((sub === 'i' || sub === 'install' || sub === 'add' || sub === 'uninstall' || sub === 'rm') && (args.includes('-g') || args.includes('--global'))) {
      return { category: 'infra', reason: `global npm ${sub} -g requires approval` };
    }
  }
  if (cmd === 'pnpm') {
    if (sub === 'publish') return { category: 'remote', reason: 'remote pnpm publish requires approval' };
    if ((sub === 'add' || sub === 'i' || sub === 'install' || sub === 'remove') && (args.includes('-g') || args.includes('--global'))) {
      return { category: 'infra', reason: `global pnpm ${sub} -g requires approval` };
    }
  }
  if (cmd === 'yarn') {
    if (sub === 'publish' || sub === 'global') {
      return { category: 'remote', reason: `yarn ${sub} requires approval` };
    }
  }
  if (cmd === 'cargo') {
    if (sub === 'publish' || sub === 'yank') {
      return { category: 'remote', reason: `remote cargo ${sub} requires approval` };
    }
  }
  if (cmd === 'twine' && sub === 'upload') {
    return { category: 'remote', reason: 'remote twine upload requires approval' };
  }
  if (cmd === 'gh') {
    const first = sub;
    const second = (args.slice(args.indexOf(first) + 1).find((a) => !a.startsWith('-')) ?? '').toLowerCase();
    if ((first === 'release' && ['create', 'delete', 'edit'].includes(second)) || (first === 'pr' && ['merge', 'close'].includes(second))) {
      return { category: 'remote', reason: `remote gh ${first} ${second} requires approval` };
    }
  }
  return null;
}

/**
 * Evaluate a single parsed command segment (scanning ALL tokens before wrapper unwrapping,
 * handling control-flow keywords, wrappers, `env -S`, `eval`, `| sh`, and heredocs).
 * Returns `{ ask: boolean, category?, reason?, parseError?, safeEnvCount: number }`.
 */
function evaluateSegment(segment, depth) {
  if (depth > MAX_PARSE_DEPTH) {
    return { ask: true, category: 'parse', reason: 'shell nesting depth exceeded safe evaluator bound', parseError: true, safeEnvCount: 0 };
  }

  let safeEnvCount = 0;

  // 1. Check redirection targets first (always file paths!).
  for (const redir of segment.redirections) {
    const envHit = classifyEnvReference(redir, { isFileContext: true, isRedirection: true });
    if (envHit) return { ask: true, category: 'secret', reason: envHit.reason, safeEnvCount: 0 };
    const secretHit = classifyOtherSecretReference(redir);
    if (secretHit) return { ask: true, category: 'secret', reason: secretHit.reason, safeEnvCount: 0 };
    const accounted = countSafeAccountedEnvOccurrences(redir, { isFileContext: true, isRedirection: true });
    if (accounted < 0) return { ask: true, category: 'secret', reason: `redirection references sensitive .env target ${redir}`, safeEnvCount: 0 };
    safeEnvCount += accounted;
  }

  // 2. Strip leading control-flow prefixes (`!`, `if`, `then`, `elif`, `else`, `do`, `while`, `until`, `time`)
  //    and trailing standalone block terminators (`fi`, `done`, `esac`).
  let tokens = segment.tokens.slice();
  while (tokens.length > 0 && CONTROL_PREFIX_WORDS.has(tokens[0].toLowerCase())) {
    tokens.shift();
  }
  while (tokens.length > 0 && CONTROL_TERMINATOR_WORDS.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }

  // 3. Skip leading VAR=value assignments (still inspect their values for secret files).
  while (tokens.length > 0 && isEnvAssignmentToken(tokens[0])) {
    const assign = tokens.shift();
    const envHit = classifyEnvReference(assign, { isFileContext: false });
    if (envHit) return { ask: true, category: 'secret', reason: envHit.reason, safeEnvCount: 0 };
    const accounted = countSafeAccountedEnvOccurrences(assign, { isFileContext: false });
    if (accounted < 0) return { ask: true, category: 'secret', reason: `assignment references sensitive .env value ${assign}`, safeEnvCount: 0 };
    safeEnvCount += accounted;
  }

  if (tokens.length === 0) {
    for (const hd of segment.heredocs) {
      const hit = inspectInlineCodeForSecrets(hd.body);
      if (hit) return { ask: true, category: 'secret', reason: hit.reason, safeEnvCount: 0 };
    }
    return { ask: false, safeEnvCount };
  }

  // 4. PRE-UNWRAP SECRET SCAN over ALL raw tokens (including wrapper flags like `xargs -a .env`,
  //    `xargs --arg-file=.env`, `timeout -s .env`, `env -S "cat .env"`!).
  const initialCmd = baseCommandName(tokens[0]);
  const initialIsFileCmd = FILE_READ_WRITE_COMMANDS.has(initialCmd);
  const preUnwrapTokens = tokens.slice();

  // 5. Unwrap wrappers while preserving and scanning every dropped wrapper flag/argument!
  const droppedWrapperArgs = [];
  let unwrapGuard = 0;
  while (unwrapGuard < 8 && tokens.length > 0) {
    unwrapGuard += 1;
    // Also strip any control prefix revealed after unwrapping
    while (tokens.length > 0 && CONTROL_PREFIX_WORDS.has(tokens[0].toLowerCase())) {
      tokens.shift();
    }
    if (tokens.length === 0) break;

    const c = baseCommandName(tokens[0]);
    const rest = tokens.slice(1);

    if (c === 'sudo' || c === 'su' || c === 'doas') {
      return { ask: true, category: 'destructive', reason: `privilege escalation (${c}) requires approval`, safeEnvCount: 0 };
    }
    if (c === 'eval') {
      return { ask: true, category: 'destructive', reason: 'dynamic shell evaluation (eval) requires approval', safeEnvCount: 0 };
    }

    if (c === 'env') {
      let idx = 1;
      while (idx < tokens.length) {
        const t = tokens[idx];
        if (t === '-S' || t === '--split-string') {
          const splitCmd = tokens[idx + 1];
          if (typeof splitCmd === 'string') {
            const inner = evaluateShellCommand(splitCmd, depth + 1);
            if (inner.ask) return { ...inner, safeEnvCount: 0 };
          } else {
            return { ask: true, category: 'parse', reason: 'env -S without argument requires approval', parseError: true, safeEnvCount: 0 };
          }
          idx += 2;
          continue;
        }
        if (t.startsWith('--split-string=')) {
          const inner = evaluateShellCommand(t.slice('--split-string='.length), depth + 1);
          if (inner.ask) return { ...inner, safeEnvCount: 0 };
          idx += 1;
          continue;
        }
        if (t === '-u' || t === '--unset' || t === '-C' || t === '--chdir' || t === '--block-signal' || t === '--default-signal' || t === '--ignore-signal') {
          droppedWrapperArgs.push(t, tokens[idx + 1] ?? '');
          idx += 2;
          continue;
        }
        if (t.startsWith('-') || isEnvAssignmentToken(t)) {
          droppedWrapperArgs.push(t);
          idx += 1;
          continue;
        }
        break;
      }
      if (idx < tokens.length) {
        tokens = tokens.slice(idx);
        continue;
      }
      break;
    }

    if (c === 'timeout') {
      let idx = 1;
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        const t = tokens[idx];
        if (t === '-k' || t === '-s' || t === '--kill-after' || t === '--signal') {
          droppedWrapperArgs.push(t, tokens[idx + 1] ?? '');
          idx += 2;
        } else {
          droppedWrapperArgs.push(t);
          idx += 1;
        }
      }
      if (idx + 1 < tokens.length) {
        droppedWrapperArgs.push(tokens[idx]); // duration
        tokens = tokens.slice(idx + 1);
        continue;
      }
      break;
    }

    if (c === 'nice') {
      const niceValFlags = new Set(['-n', '--adjustment']);
      const inner = firstPositionalAfterFlags(rest, niceValFlags);
      if (inner.index >= 0) {
        droppedWrapperArgs.push(...rest.slice(0, inner.index));
        tokens = rest.slice(inner.index);
        continue;
      }
      break;
    }

    if (c === 'ionice') {
      const ioniceValFlags = new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid']);
      const inner = firstPositionalAfterFlags(rest, ioniceValFlags);
      if (inner.index >= 0) {
        droppedWrapperArgs.push(...rest.slice(0, inner.index));
        tokens = rest.slice(inner.index);
        continue;
      }
      break;
    }

    if (TRANSPARENT_WRAPPERS.has(c)) {
      let idx = 1;
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        droppedWrapperArgs.push(tokens[idx]);
        idx += 1;
      }
      if (idx < tokens.length) {
        tokens = tokens.slice(idx);
        continue;
      }
      break;
    }

    if (c === 'xargs') {
      const xargsValFlags = new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--arg-file', '--max-args', '--max-procs', '--replace', '--delimiter']);
      const inner = firstPositionalAfterFlags(rest, xargsValFlags);
      if (inner.index >= 0) {
        droppedWrapperArgs.push(...rest.slice(0, inner.index));
        tokens = rest.slice(inner.index);
        continue;
      }
      droppedWrapperArgs.push(...rest);
      break;
    }

    break;
  }

  // Scan EVERY dropped wrapper argument strictly in file context (`xargs -a .env`, `timeout -s .env`, etc.)!
  for (const wArg of droppedWrapperArgs) {
    if (!wArg) continue;
    const envHit = classifyEnvReference(wArg, { isFileContext: true });
    if (envHit) return { ask: true, category: 'secret', reason: envHit.reason, safeEnvCount: 0 };
    const secretHit = classifyOtherSecretReference(wArg);
    if (secretHit) return { ask: true, category: 'secret', reason: secretHit.reason, safeEnvCount: 0 };
    const accounted = countSafeAccountedEnvOccurrences(wArg, { isFileContext: true });
    if (accounted < 0) return { ask: true, category: 'secret', reason: `wrapper argument references sensitive .env (${wArg})`, safeEnvCount: 0 };
    safeEnvCount += accounted;
  }

  if (tokens.length === 0) {
    return { ask: false, safeEnvCount };
  }

  const cmd = baseCommandName(tokens[0]);
  const args = tokens.slice(1);

  if (cmd === 'sudo' || cmd === 'su' || cmd === 'doas') {
    return { ask: true, category: 'destructive', reason: `privilege escalation (${cmd}) requires approval`, safeEnvCount: 0 };
  }
  if (cmd === 'eval') {
    return { ask: true, category: 'destructive', reason: 'dynamic shell evaluation (eval) requires approval', safeEnvCount: 0 };
  }

  // 6. Piping directly into a shell (`echo "..." | bash`, `curl ... | sh`) ALWAYS asks!
  if (segment.pipedIn && SHELL_LAUNCHERS.has(cmd)) {
    return { ask: true, category: 'remote', reason: `piping input into shell (${cmd}) requires approval`, safeEnvCount: 0 };
  }

  // 7. Shell `-c` recursion (`bash -c "..."`, `sh -lc "..."`) and heredoc into shell
  if (SHELL_LAUNCHERS.has(cmd)) {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '-c' || /^-[a-zA-Z]*c$/.test(arg)) {
        const innerCmd = args[i + 1];
        if (typeof innerCmd === 'string') {
          const innerEval = evaluateShellCommand(innerCmd, depth + 1);
          if (innerEval.ask) return { ...innerEval, safeEnvCount: 0 };
        }
        break;
      }
    }
    for (const hd of segment.heredocs) {
      const innerEval = evaluateShellCommand(hd.body, depth + 1);
      if (innerEval.ask) return { ...innerEval, safeEnvCount: 0 };
    }
  }

  // 8. Check arguments for secret file references (`--env-file`, file commands, general args).
  const isFileCmd = initialIsFileCmd || FILE_READ_WRITE_COMMANDS.has(cmd);
  const isInlineCmd = INLINE_SCRIPT_COMMANDS.has(cmd);
  let expectEnvFile = false;
  let expectInlineCode = false;

  // Check command token itself (e.g. `./.env` executed directly)
  const cmdEnvHit = classifyEnvReference(tokens[0], { isFileContext: true });
  if (cmdEnvHit) return { ask: true, category: 'secret', reason: cmdEnvHit.reason, safeEnvCount: 0 };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (expectEnvFile) {
      expectEnvFile = false;
      const envHit = classifyEnvReference(arg, { isFileContext: true });
      if (envHit) return { ask: true, category: 'secret', reason: envHit.reason, safeEnvCount: 0 };
      const secretHit = classifyOtherSecretReference(arg);
      if (secretHit) return { ask: true, category: 'secret', reason: secretHit.reason, safeEnvCount: 0 };
      const accounted = countSafeAccountedEnvOccurrences(arg, { isFileContext: true });
      if (accounted < 0) return { ask: true, category: 'secret', reason: `env-file references sensitive .env (${arg})`, safeEnvCount: 0 };
      safeEnvCount += accounted;
      continue;
    }
    if (expectInlineCode) {
      expectInlineCode = false;
      const hit = inspectInlineCodeForSecrets(arg);
      if (hit) return { ask: true, category: 'secret', reason: hit.reason, safeEnvCount: 0 };
      const accounted = countSafeAccountedEnvOccurrences(arg, { isFileContext: false });
      if (accounted < 0) return { ask: true, category: 'secret', reason: 'inline code references sensitive .env', safeEnvCount: 0 };
      safeEnvCount += accounted;
      continue;
    }
    if (arg === '--env-file') {
      expectEnvFile = true;
      continue;
    }
    if (isInlineCmd && (arg === '-e' || arg === '-c' || arg === '--eval')) {
      expectInlineCode = true;
      continue;
    }

    const envHit = classifyEnvReference(arg, { isFileContext: isFileCmd });
    if (envHit) return { ask: true, category: 'secret', reason: envHit.reason, safeEnvCount: 0 };
    const secretHit = classifyOtherSecretReference(arg);
    if (secretHit) return { ask: true, category: 'secret', reason: secretHit.reason, safeEnvCount: 0 };
    const accounted = countSafeAccountedEnvOccurrences(arg, { isFileContext: isFileCmd });
    if (accounted < 0) return { ask: true, category: 'secret', reason: `argument references sensitive .env (${arg})`, safeEnvCount: 0 };
    safeEnvCount += accounted;
  }

  // Check heredoc bodies for inline scripts (or any heredoc mentioning `.env`)
  for (const hd of segment.heredocs) {
    if (isInlineCmd) {
      const hit = inspectInlineCodeForSecrets(hd.body);
      if (hit) return { ask: true, category: 'secret', reason: hit.reason, safeEnvCount: 0 };
    }
    // Never silently allow `.env` inside arbitrary heredoc bodies unless explicitly safe
    if (hd.body.toLowerCase().includes('.env')) {
      const hit = inspectInlineCodeForSecrets(hd.body);
      if (hit) return { ask: true, category: 'secret', reason: hit.reason, safeEnvCount: 0 };
    }
  }

  // Defensive check: ensure preUnwrapTokens didn't smuggle any unexamined token
  void preUnwrapTokens;

  // 9. Destructive local mutations.
  if (cmd === 'rm') {
    if (hasShortFlag(args, 'r') || hasShortFlag(args, 'R') || args.includes('--recursive')) {
      return { ask: true, category: 'destructive', reason: 'recursive rm requires approval', safeEnvCount: 0 };
    }
  }
  if (cmd === 'chmod') {
    if (hasShortFlag(args, 'R') || args.includes('--recursive')) {
      return { ask: true, category: 'destructive', reason: 'recursive chmod -R requires approval', safeEnvCount: 0 };
    }
  }
  if (DESTRUCTIVE_SYSTEM_COMMANDS.has(cmd) || cmd.startsWith('mkfs')) {
    return { ask: true, category: 'destructive', reason: `destructive system command (${cmd}) requires approval`, safeEnvCount: 0 };
  }

  // 10. Git destructive / remote mutations.
  if (cmd === 'git') {
    const gitHit = checkGitCommand(args);
    if (gitHit) return { ask: true, ...gitHit, safeEnvCount: 0 };
  }

  // 11. Remote / publish / infra / DB mutations.
  const pkgHit = checkPackageManagerCommand(cmd, args);
  if (pkgHit) return { ask: true, ...pkgHit, safeEnvCount: 0 };

  if (REMOTE_TRANSFER_COMMANDS.has(cmd)) {
    return { ask: true, category: 'remote', reason: `remote transfer/login (${cmd}) requires approval`, safeEnvCount: 0 };
  }
  if (cmd === 'curl') {
    const curlHit = checkCurlCommand(args);
    if (curlHit) return { ask: true, ...curlHit, safeEnvCount: 0 };
  }
  if (cmd === 'docker') {
    const dockerHit = checkDockerCommand(args);
    if (dockerHit) return { ask: true, ...dockerHit, safeEnvCount: 0 };
  }
  if (cmd === 'docker-compose') {
    const dockerHit = checkDockerCommand(['compose', ...args]);
    if (dockerHit) return { ask: true, ...dockerHit, safeEnvCount: 0 };
  }
  if (cmd === 'systemctl') {
    const verb = firstPositionalAfterFlags(args, new Set(['-H', '--host', '-M', '--machine', '--root'])).value.toLowerCase();
    if (MUTATING_SYSTEMCTL_VERBS.has(verb)) {
      return { ask: true, category: 'infra', reason: `mutating systemctl ${verb} requires approval`, safeEnvCount: 0 };
    }
  }
  if (DB_CLI_COMMANDS.has(cmd)) {
    return { ask: true, category: 'data', reason: `direct database CLI (${cmd}) requires approval`, safeEnvCount: 0 };
  }
  if (CLOUD_CLI_COMMANDS.has(cmd)) {
    return { ask: true, category: 'infra', reason: `cloud CLI (${cmd}) requires approval`, safeEnvCount: 0 };
  }
  if (cmd === 'terraform' || cmd === 'tofu') {
    const verb = firstPositionalAfterFlags(args, new Set(['-chdir'])).value.toLowerCase();
    if (MUTATING_TERRAFORM_SUBCOMMANDS.has(verb)) {
      return { ask: true, category: 'infra', reason: `mutating ${cmd} ${verb} requires approval`, safeEnvCount: 0 };
    }
  }
  if (cmd === 'kubectl') {
    const kubectlValFlags = new Set(['-n', '--namespace', '--context', '--kubeconfig', '--cluster']);
    const verb = firstPositionalAfterFlags(args, kubectlValFlags).value.toLowerCase();
    if (MUTATING_KUBECTL_SUBCOMMANDS.has(verb)) {
      return { ask: true, category: 'infra', reason: `mutating kubectl ${verb} requires approval`, safeEnvCount: 0 };
    }
  }
  if (cmd === 'helm') {
    const helmValFlags = new Set(['-n', '--namespace', '--kube-context', '--kubeconfig']);
    const verb = firstPositionalAfterFlags(args, helmValFlags).value.toLowerCase();
    if (MUTATING_HELM_SUBCOMMANDS.has(verb)) {
      return { ask: true, category: 'infra', reason: `mutating helm ${verb} requires approval`, safeEnvCount: 0 };
    }
  }

  return { ask: false, safeEnvCount };
}

/**
 * Evaluate a full shell command string (including compound segments and embedded subshells).
 * Returns `{ ask: boolean, parsed: boolean, allEnvAccounted: boolean, category?, reason? }`.
 */
export function evaluateShellCommand(command, depth = 0) {
  if (depth > MAX_PARSE_DEPTH) {
    return { ask: true, parsed: false, allEnvAccounted: false, category: 'parse', reason: 'shell nesting depth exceeded safe evaluator bound' };
  }
  const parsed = parseShellSegments(command);
  if (!parsed.ok) {
    return { ask: true, parsed: false, allEnvAccounted: false, category: 'parse', reason: `unparseable shell command (${parsed.error})` };
  }

  let totalSafeEnv = 0;
  for (const segment of parsed.segments) {
    const verdict = evaluateSegment(segment, depth);
    if (verdict.ask) {
      return {
        ask: true,
        parsed: !verdict.parseError,
        allEnvAccounted: false,
        category: verdict.category,
        reason: verdict.reason,
      };
    }
    totalSafeEnv += verdict.safeEnvCount ?? 0;
  }

  for (const sub of parsed.subshells) {
    const subVerdict = evaluateShellCommand(sub, depth + 1);
    if (subVerdict.ask) return subVerdict;
  }

  // Strict accounting for `ask -> allow` override:
  // Every `.env` substring in the raw command must have been explicitly accounted for by a
  // parsed safe token (no comments hiding `.env`, no unaccounted heredoc `.env`, no subshell `.env`).
  const rawEnvCount = countOccurrences(command, '.env');
  const allEnvAccounted =
    rawEnvCount === 0 ||
    (!parsed.hasComments && parsed.subshells.length === 0 && totalSafeEnv === rawEnvCount);

  return { ask: false, parsed: true, allEnvAccounted };
}

/**
 * Main handler for `ctx.permission.hook("evaluate", ...)`.
 * Mutates `input.effect` (and `input.message` when escalating) in place, and returns
 * a structured audit summary `{ originalEffect, finalEffect, overridden, category, reason }`.
 */
export function evaluatePermissionInput(input) {
  if (!input || typeof input !== 'object') {
    return { overridden: false, originalEffect: null, finalEffect: null, reason: null };
  }
  const originalEffect = input.effect ?? null;
  const action = typeof input.action === 'string' ? input.action.toLowerCase() : '';

  // CRITICAL: Never weaken an explicit `deny` (e.g. read-only agents).
  if (originalEffect === 'deny') {
    return { overridden: false, originalEffect, finalEffect: 'deny', reason: null };
  }

  if (!SHELL_ACTIONS.has(action)) {
    return { overridden: false, originalEffect, finalEffect: originalEffect, reason: null };
  }

  const resources = Array.isArray(input.resources)
    ? input.resources.filter((item) => typeof item === 'string')
    : typeof input.resources === 'string'
      ? [input.resources]
      : [];

  if (resources.length === 0) {
    return { overridden: false, originalEffect, finalEffect: originalEffect, reason: null };
  }

  let allParsedCleanly = true;
  let allEnvAccounted = true;
  let anyHasEnv = false;

  for (const resource of resources) {
    if (resource.toLowerCase().includes('.env')) anyHasEnv = true;
    const verdict = evaluateShellCommand(resource);
    if (!verdict.parsed) allParsedCleanly = false;
    if (!verdict.allEnvAccounted) allEnvAccounted = false;
    if (verdict.ask) {
      const overridden = originalEffect !== 'ask';
      input.effect = 'ask';
      if (!input.message) {
        input.message = `Permission guard: ${verdict.reason}`;
      }
      return {
        overridden,
        originalEffect,
        finalEffect: 'ask',
        category: verdict.category ?? null,
        reason: verdict.reason ?? null,
      };
    }
  }

  // Override static fail-closed `*.env*` `ask -> allow` ONLY when:
  //   1. `originalEffect === "ask"` with no explicit rule/caller message,
  //   2. Every resource parsed cleanly,
  //   3. At least one resource contained `.env`, AND
  //   4. EVERY `.env` substring in the raw resource was strictly accounted for as a safe
  //      template (`.env.example`/...) or safe code identifier (`process.env`/...)!
  if (originalEffect === 'ask' && !input.message && allParsedCleanly && anyHasEnv && allEnvAccounted) {
    input.effect = 'allow';
    return {
      overridden: true,
      originalEffect,
      finalEffect: 'allow',
      category: 'env_safe_override',
      reason: 'every .env reference parsed as safe template or code identifier with no mutating command',
    };
  }

  return { overridden: false, originalEffect, finalEffect: originalEffect, reason: null };
}
