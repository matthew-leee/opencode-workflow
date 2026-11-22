// Model Shootout roster — the approved 10-model list (6 frontier + 4 fast/cheap workers).
//
// Catalog verification (OpenCode v2.3.2, `/root/.cache/opencode/models.json`):
//   A `#variant` suffix is only accepted when the model advertises a matching reasoning
//   effort. The catalog exposes `reasoning_options` per model, so:
//     gemini-4-neon        effort: low|medium|high|xhigh          -> #high  OK
//     gemini-4-hydrogen    effort: low|medium|high|xhigh          -> #high  OK
//     claude-opus-5.5      effort: low|medium|high|xhigh|max      -> #high  OK
//     gpt-6.2-sol          effort: low|medium|high|xhigh|max      -> #high  OK
//     kimi-k3.1-pro        effort: none|low|high|max              -> #medium NOT ADVERTISED
//     qwen4-max            effort: none|low|high|xhigh            -> (approved without variant)
//     hy4-flash            reasoning_options: [{type:"toggle"}]   -> no effort values at all
//   The approved roster asked for `kimi-k3.1-pro#medium`. `medium` is not in that model's
//   advertised effort values, so the suffix is omitted cleanly (the CLI resolves the catalog
//   default) and the reason is recorded in `variantNote`. `verifyAgainstCatalog()` re-checks all
//   of this against the on-disk catalog so the roster can never silently drift from the runtime.
//
// Ordering: workers first (cheap tasks finish well inside the $5 budget), then frontier models
// sorted by blended price per 1M tokens ((input + output) / 2), so the cheapest frontier slots
// are consumed before the expensive ones if the budget runs out mid-sweep.

/** Where the model/variant facts below came from. */
export const CATALOG_SOURCE = "OpenCode v2.3.2 catalog: /root/.cache/opencode/models.json";

/**
 * Blended price used only for ordering and for cost-estimate preflights.
 * USD per 1M tokens, snapshot of the catalog at roster creation time.
 * @typedef {{input:number,output:number,cacheRead:number,cacheWrite:number}} Pricing
 */
const PRICING = {
  "openrouter/tencent/hy4-flash": { input: 0.035, output: 0.1405, cacheRead: 0.0015, cacheWrite: 0 },
  "openrouter/openai/gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "openrouter/minimax/minimax-m3.1-flash": { input: 0.135, output: 0.54, cacheRead: 0.0135, cacheWrite: 0 },
  "openrouter/deepseek/deepseek-v4.1-flash-1017": { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
  "openrouter/moonshotai/kimi-k3.1-pro": { input: 0.253, output: 8.8, cacheRead: 0.18, cacheWrite: 0 },
  "openrouter/qwen/qwen4-max": { input: 1.425, output: 4.275, cacheRead: 0.07125, cacheWrite: 1.78125 },
  "openrouter/google/gemini-4-hydrogen": { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0.083333 },
  "openrouter/openai/gpt-6.2-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "openrouter/google/gemini-4-neon": { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0.083333 },
  "openrouter/anthropic/claude-opus-5.5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/**
 * The approved roster. `base` + `variant` are combined by `modelId()`.
 * `approved` keeps the literal string the user approved so a drift is visible in review.
 */
export const ROSTER = [
  {
    key: "hy4-flash",
    label: "Hy4 Flash",
    tier: "worker",
    base: "openrouter/tencent/hy4-flash",
    variant: null,
    approved: "openrouter/tencent/hy4-flash",
    variantNote: "catalog reasoning_options is a toggle, not an effort scale; no suffix accepted",
  },
  {
    key: "gpt-6-luna",
    label: "GPT-6 Luna",
    tier: "worker",
    base: "openrouter/openai/gpt-6-luna",
    variant: null,
    approved: "openrouter/openai/gpt-6-luna",
    variantNote: "approved without a variant; catalog defaults kept for comparability",
  },
  {
    key: "minimax-m3.1-flash",
    label: "MiniMax M3.1 Flash",
    tier: "worker",
    base: "openrouter/minimax/minimax-m3.1-flash",
    variant: null,
    approved: "openrouter/minimax/minimax-m3.1-flash",
    variantNote: "approved without a variant; catalog defaults kept for comparability",
  },
  {
    key: "deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash",
    tier: "worker",
    base: "openrouter/deepseek/deepseek-v4.1-flash-1017",
    variant: null,
    approved: "openrouter/deepseek/deepseek-v4.1-flash-1017",
    variantNote: "approved without a variant; catalog defaults kept for comparability",
  },
  {
    key: "qwen4-max",
    label: "Qwen4 Max",
    tier: "frontier",
    base: "openrouter/qwen/qwen4-max",
    variant: null,
    approved: "openrouter/qwen/qwen4-max",
    variantNote: "approved without a variant; catalog defaults kept for comparability",
  },
  {
    key: "gemini-4-hydrogen",
    label: "Gemini 4 Hydrogen",
    tier: "frontier",
    base: "openrouter/google/gemini-4-hydrogen",
    variant: "high",
    approved: "openrouter/google/gemini-4-hydrogen#high",
    variantNote: "catalog effort includes high",
  },
  {
    key: "kimi-k3.1-pro",
    label: "Kimi K3.1 Pro",
    tier: "frontier",
    base: "openrouter/moonshotai/kimi-k3.1-pro",
    variant: null,
    approved: "openrouter/moonshotai/kimi-k3.1-pro#medium",
    variantNote:
      "approved as #medium but the catalog advertises effort none|low|high|max, so #medium is " +
      "rejected; suffix omitted (catalog default effort) rather than substituting an unapproved value",
  },
  {
    key: "gpt-6.2-sol",
    label: "GPT-6.2 Sol",
    tier: "frontier",
    base: "openrouter/openai/gpt-6.2-sol",
    variant: "high",
    approved: "openrouter/openai/gpt-6.2-sol#high",
    variantNote: "catalog effort includes high",
  },
  {
    key: "gemini-4-neon",
    label: "Gemini 4 Neon",
    tier: "frontier",
    base: "openrouter/google/gemini-4-neon",
    variant: "high",
    approved: "openrouter/google/gemini-4-neon#high",
    variantNote: "catalog effort includes high",
  },
  {
    key: "claude-opus-5.5",
    label: "Claude Opus 5.5",
    tier: "frontier",
    base: "openrouter/anthropic/claude-opus-5.5",
    variant: "high",
    approved: "openrouter/anthropic/claude-opus-5.5#high",
    variantNote: "catalog effort includes high",
  },
];

/** Full OpenCode model string, e.g. `openrouter/google/gemini-4-neon#high`. */
export function modelId(entry) {
  return entry.variant ? `${entry.base}#${entry.variant}` : entry.base;
}

/** Blended USD/1M-token price used for ordering and preflight cost estimates. */
export function blendedPrice(entry) {
  const pricing = PRICING[entry.base];
  if (!pricing) return Number.POSITIVE_INFINITY;
  return (pricing.input + pricing.output) / 2;
}

/** Catalog pricing snapshot for a roster entry (USD per 1M tokens). */
export function pricingFor(entry) {
  return PRICING[entry.base] ?? null;
}

/**
 * Resolve roster entries from a CSV of model keys, full model ids, or approved strings.
 * Unknown names throw so a typo cannot silently shrink the sweep.
 */
export function selectModels(spec, roster = ROSTER) {
  if (!spec) return [...roster];
  const wanted = spec
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const selected = [];
  for (const name of wanted) {
    const match = roster.find(
      (entry) =>
        entry.key === name ||
        modelId(entry) === name ||
        entry.base === name ||
        entry.approved === name,
    );
    if (!match) {
      const known = roster.map((entry) => entry.key).join(", ");
      throw new Error(`unknown model "${name}" — known roster keys: ${known}`);
    }
    if (!selected.includes(match)) selected.push(match);
  }
  return selected;
}

/**
 * Guards the two roster invariants the budget relies on:
 *   1. every worker appears before every frontier model;
 *   2. within a tier, blended price is non-decreasing.
 */
export function assertRosterInvariants(roster = ROSTER) {
  if (roster.length === 0) throw new Error("roster is empty");
  const tierRank = (entry) => (entry.tier === "worker" ? 0 : 1);
  let previousRank = -1;
  let previousPrice = -Infinity;
  for (const entry of roster) {
    const rank = tierRank(entry);
    if (rank < previousRank) {
      throw new Error(`roster order violation: ${entry.key} (${entry.tier}) follows a ${previousRank === 0 ? "worker" : "frontier"} model`);
    }
    if (rank > previousRank) {
      previousRank = rank;
      previousPrice = -Infinity;
    }
    const price = blendedPrice(entry);
    if (price < previousPrice) {
      throw new Error(`roster price order violation: ${entry.key} is cheaper than its predecessor`);
    }
    previousPrice = price;
    if (entry.tier !== "worker" && entry.tier !== "frontier") {
      throw new Error(`unknown tier "${entry.tier}" for ${entry.key}`);
    }
  }
  return true;
}

/**
 * Cross-check the roster against the OpenCode catalog: every model id must exist and every
 * `#variant` must be an advertised reasoning effort. Returns a report instead of throwing so
 * `runner --dry-run` can print it, while tests assert `ok === true`.
 */
export function verifyAgainstCatalog(roster = ROSTER, catalog = null) {
  if (!catalog || typeof catalog !== "object") {
    return { available: false, ok: false, checked: [], problems: ["catalog not provided"] };
  }
  const checked = [];
  const problems = [];
  for (const entry of roster) {
    const [provider, ...rest] = entry.base.split("/");
    const modelKey = rest.join("/");
    const model = catalog[provider]?.models?.[modelKey];
    if (!model) {
      problems.push(`${entry.base}: not present in catalog`);
      checked.push({ key: entry.key, model: modelId(entry), present: false, variantOk: false });
      continue;
    }
    const efforts = (model.reasoning_options ?? [])
      .filter((option) => option?.type === "effort")
      .flatMap((option) => option.values ?? []);
    const variantOk = entry.variant === null ? true : efforts.includes(entry.variant);
    if (!variantOk) {
      problems.push(
        `${entry.key}: variant "#${entry.variant}" is not advertised (catalog efforts: ${efforts.join("|") || "none"})`,
      );
    }
    checked.push({ key: entry.key, model: modelId(entry), present: true, efforts, variantOk });
  }
  return { available: true, ok: problems.length === 0, checked, problems };
}

/** Human-readable roster table for `--dry-run` and REPORT.md. */
export function formatRosterTable(roster = ROSTER) {
  const rows = roster.map((entry, index) => {
    const price = blendedPrice(entry);
    const blended = Number.isFinite(price) ? price.toFixed(3) : "?";
    return `| ${index + 1} | ${entry.key} | ${entry.tier} | \`${modelId(entry)}\` | ${blended} |`;
  });
  return [
    "| # | key | tier | OpenCode model id | blended $/1M |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
