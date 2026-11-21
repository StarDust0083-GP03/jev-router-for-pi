import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import autoRouter, {
  clampTier,
  configSignature,
  DEFAULTS,
  isSubagentSession,
  loadConfig,
  normalizeConfig,
  pick,
  planRetry,
  tierFromLevel,
  tierFromScore,
  tierOf,
  type Config,
  type State,
} from "../src/auto-router.ts";

const TIERS = [
  { provider: "p", id: "strong", thinking: "high" as const, when: "hard" },
  { provider: "p", id: "middle", thinking: "high" as const, when: "ordinary" },
  { provider: "p", id: "cheap", thinking: "off" as const, when: "easy" },
];

function config(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULTS, tiers: TIERS, levelTiers: { xhigh: 0, high: 1, low: 2 }, classifier: null, ...overrides };
}

interface Call {
  url: string;
  payload: unknown;
  signal: AbortSignal | undefined;
}

function registry(calls: Call[] = [], onClassify?: (calls: Call[]) => unknown) {
  return {
    calls,
    find(provider: string, id: string) {
      return { provider, id };
    },
    findOfType(_type: string, provider: string, id: string) {
      return { provider, id };
    },
    async classify(_model: unknown, payload: unknown, options: { signal?: AbortSignal }) {
      calls.push({ url: "classify", payload, signal: options?.signal });
      if (onClassify) return await onClassify(calls);
      return { stopReason: "stop", answers: { tier: { type: "score", score: 0 } } };
    },
  };
}

function userRequest(extra: Record<string, unknown> = {}) {
  return {
    reason: "user",
    messages: [{ role: "user", content: "local test" }],
    thinkingLevel: "high",
    ...extra,
  };
}

async function routeWith(cfg: Config, request: any, ctx: ReturnType<typeof registry>, id = cfg.id) {
  const dir = mkdtempSync(join(tmpdir(), "auto-router-test-"));
  const file = join(dir, "auto-router.json");
  const previous = process.env.AUTO_ROUTER_CONFIG;
  const models = new Map<string, any>();
  try {
    writeFileSync(file, JSON.stringify(cfg));
    process.env.AUTO_ROUTER_CONFIG = file;
    autoRouter({ registerVirtualModel: (definition: any) => models.set(definition.id, definition), on: () => {} } as never);
    return await models.get(id).route(request, { modelRegistry: ctx });
  } finally {
    if (previous === undefined) delete process.env.AUTO_ROUTER_CONFIG;
    else process.env.AUTO_ROUTER_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("router/subagent defaults to the last configured tier and never classifies", async () => {
  const cfg = config({ tiers: [...TIERS, { provider: "p", id: "last", thinking: "minimal" }], classifier: DEFAULTS.classifier });
  const ctx = registry();
  for (const reason of ["user", "continuation", "retry", "direct"]) {
    const result = await routeWith(cfg, userRequest({ reason, previous: { model: TIERS[0] } }), ctx, "subagent");
    assert.equal(result.model.id, "last");
    assert.equal(result.thinkingLevel, "minimal");
    assert.equal(result.state, undefined);
  }
  assert.equal(ctx.calls.length, 0);
});

test("router/subagent uses the explicit tier and its thinking level", async () => {
  const result = await routeWith(config({ subagentTier: 1, compactTier: 2 }), userRequest(), registry(), "subagent");
  assert.equal(result.model.id, "middle");
  assert.equal(result.thinkingLevel, "high");
});

test("the main router cannot shadow the stable subagent alias", () => {
  assert.equal(normalizeConfig({ provider: "router", id: "subagent" }).id, "auto");
});

test("defaults are strongest first and every index is reachable", () => {
  assert.equal(DEFAULTS.tiers.length, 3);
  assert.equal(DEFAULTS.tiers[0].thinking, "high");
  assert.equal(DEFAULTS.tiers.at(-1)!.thinking, "off");
  assert.equal(DEFAULTS.classifier!.timeoutMs > 0, true);
});

test("normalizeConfig keeps defaults for a missing file and ignores unknown keys", () => {
  assert.deepEqual(normalizeConfig(undefined), DEFAULTS);
  assert.deepEqual(normalizeConfig({ nope: true }), DEFAULTS);
  assert.deepEqual(loadConfig("/nonexistent/auto-router.json"), DEFAULTS);
});

test("normalizeConfig validates tiers instead of trusting the shape", () => {
  const warnings: string[] = [];
  const cfg = normalizeConfig(
    { tiers: [{ provider: "p", id: "a" }, { provider: "p" }, { id: "b" }, "junk"], debug: true },
    (message) => warnings.push(message),
  );
  assert.deepEqual(cfg.tiers, [{ provider: "p", id: "a" }]);
  assert.equal(cfg.debug, true);
  assert.equal(warnings.length, 3);
});

test("normalizeConfig falls back when tiers would be empty", () => {
  const warnings: string[] = [];
  const cfg = normalizeConfig({ tiers: [] }, (message) => warnings.push(message));
  assert.deepEqual(cfg.tiers, DEFAULTS.tiers);
  assert.equal(warnings.length, 1);
});

test("normalizeConfig clamps level tiers and rejects unknown levels", () => {
  const warnings: string[] = [];
  const cfg = normalizeConfig(
    {
      tiers: [{ provider: "p", id: "a" }],
      levelTiers: { high: 9, medium: -3, bogus: 0 },
      defaultLevelTier: 7,
    },
    (message) => warnings.push(message),
  );
  assert.deepEqual(cfg.levelTiers, { high: 0, medium: 0 });
  assert.equal(cfg.defaultLevelTier, 0);
  assert.equal(warnings.length, 1, "only the unknown level is reported; clamping is silent");
});

test("normalizeConfig keeps invalid classifier fields out and allows a null classifier", () => {
  const warnings: string[] = [];
  const cfg = normalizeConfig({ classifier: { provider: "openrouter", id: "" } }, (m) => warnings.push(m));
  assert.equal(cfg.classifier!.provider, "openrouter");
  assert.equal(cfg.classifier!.id, DEFAULTS.classifier!.id);
  assert.equal(warnings.length, 1);
  assert.equal(normalizeConfig({ classifier: null }).classifier, null);
});

test("configSignature changes when tiers are reordered or replaced", () => {
  const a = configSignature({ tiers: TIERS });
  const b = configSignature({ tiers: [TIERS[1], TIERS[0], TIERS[2]] });
  const c = configSignature({ tiers: [{ provider: "p", id: "other" }] });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a, configSignature({ tiers: TIERS }));
});

test("tierFromScore maps score 0 to the cheapest tier and clamps out of range", () => {
  const cfg = config();
  assert.equal(tierFromScore(0, cfg), 2);
  assert.equal(tierFromScore(1.4, cfg), 1);
  assert.equal(tierFromScore(2, cfg), 0);
  assert.equal(tierFromScore(-5, cfg), 2);
  assert.equal(tierFromScore(99, cfg), 0);
  assert.equal(tierFromScore(Number.NaN, cfg), 0);
});

test("tierFromLevel follows levelTiers and falls back to defaultLevelTier", () => {
  const cfg = config();
  assert.equal(tierFromLevel("xhigh", cfg), 0);
  assert.equal(tierFromLevel("low", cfg), 2);
  assert.equal(tierFromLevel("medium", cfg), DEFAULTS.defaultLevelTier);
  assert.equal(tierFromLevel("bogus", cfg), DEFAULTS.defaultLevelTier);
  assert.equal(tierFromLevel(undefined, cfg), DEFAULTS.defaultLevelTier);
});

test("tierOf only recognises the configured physical models", () => {
  const cfg = config();
  assert.equal(tierOf({ provider: "p", id: "middle" }, cfg), 1);
  assert.equal(tierOf({ provider: "p", id: "elsewhere" }, cfg), undefined);
  assert.equal(tierOf(undefined, cfg), undefined);
});

test("planRetry drops one tier on quota and raises the floor", () => {
  const cfg = config();
  const state: State = { tier: 1, floor: 0, decided: true, sig: configSignature(cfg) };
  const quota = planRetry(state, { model: { provider: "p", id: "middle" }, message: { errorMessage: "429 rate limit" } }, cfg);
  assert.deepEqual([quota.tier, quota.floor], [2, 2]);
  const other = planRetry(state, { model: { provider: "p", id: "middle" }, message: { errorMessage: "socket hang up" } }, cfg);
  assert.deepEqual([other.tier, other.floor], [1, 0]);
  assert.deepEqual(planRetry(state, undefined, cfg), state);
});

test("planRetry keeps the floor monotonic", () => {
  const cfg = config();
  const state: State = { tier: 2, floor: 2, decided: true, sig: configSignature(cfg) };
  const next = planRetry(state, { model: { provider: "p", id: "cheap" }, message: { errorMessage: "insufficient_quota" } }, cfg);
  assert.deepEqual([next.tier, next.floor], [2, 2]);
});

test("clampTier never returns a negative or out-of-range index", () => {
  assert.equal(clampTier(-4, 3), 0);
  assert.equal(clampTier(9, 3), 2);
  assert.equal(clampTier(Number.NaN, 3), 0);
  assert.equal(clampTier(1.6, 3), 2);
});

test("pick applies the floor, so no path can route above it", () => {
  const cfg = config();
  const ctx = { modelRegistry: registry() };
  const route = pick(ctx as never, cfg, 0, 2, true, configSignature(cfg), undefined);
  assert.equal(route.model.id, "cheap");
  assert.equal(route.state!.floor, 2);
  const direct = pick(ctx as never, cfg, 0, 2, true, configSignature(cfg), undefined);
  assert.equal(direct.model.id, "cheap");
});

test("pick returns no new state when nothing changed", () => {
  const cfg = config();
  const ctx = { modelRegistry: registry() };
  const first = pick(ctx as never, cfg, 1, 0, true, configSignature(cfg), undefined);
  const second = pick(ctx as never, cfg, 1, 0, true, configSignature(cfg), first.state);
  assert.equal(second.state, undefined);
});

test("pick names the model and the config path when a tier cannot be resolved", () => {
  const cfg = config();
  const ctx = { modelRegistry: { find: () => undefined } };
  assert.throws(
    () => pick(ctx as never, cfg, 1, 0, true, configSignature(cfg), undefined),
    /auto-router: p\/middle \(tier 1\) is not in the catalog/,
  );
});

test("subagent detection accepts truthy env values and rejects 0/false", () => {
  const cfg = config({ subagentEnv: ["PI_SUBAGENT_CHILD", "ALT_FLAG"] });
  assert.equal(isSubagentSession(cfg, {}), false);
  assert.equal(isSubagentSession(cfg, { PI_SUBAGENT_CHILD: "1" }), true);
  assert.equal(isSubagentSession(cfg, { PI_SUBAGENT_CHILD: "0" }), false);
  assert.equal(isSubagentSession(cfg, { PI_SUBAGENT_CHILD: "false" }), false);
  assert.equal(isSubagentSession(cfg, { ALT_FLAG: "yes" }), true);
  assert.equal(isSubagentSession(config({ subagentEnv: [] }), { PI_SUBAGENT_CHILD: "1" }), false);
});

test("route: continuation stays on the answering tier but cannot cross the floor", async () => {
  const cfg = config();
  const ctx = registry();
  const state: State = { tier: 2, floor: 2, decided: true, sig: configSignature(cfg) };
  const result = await routeWith(
    cfg,
    {
      reason: "continuation",
      messages: [],
      previous: { model: { provider: "p", id: "strong" }, thinkingLevel: "high" },
      state: { ...state, sig: configSignature(cfg) },
    },
    ctx,
  );
  assert.equal(result.model.id, "cheap");
  assert.equal(ctx.calls.length, 0);
});

test("route: the first user message is classified once and then reused", async () => {
  const cfg = config({ classifier: DEFAULTS.classifier });
  const ctx = registry([], () => ({ stopReason: "stop", answers: { tier: { type: "score", score: 2 } } }));
  const first = await routeWith(cfg, userRequest(), ctx);
  assert.equal(first.model.id, "strong");
  assert.equal(first.state!.decided, true);
  const second = await routeWith(cfg, userRequest({ previous: { model: { provider: "p", id: "strong" } }, state: first.state }), ctx);
  assert.equal(second.model.id, "strong");
  assert.equal(ctx.calls.length, 1, "one classifier call for the whole session");
});

test("route: classifier criteria are ordered cheapest first", async () => {
  const cfg = config({ classifier: DEFAULTS.classifier });
  const ctx = registry();
  await routeWith(cfg, userRequest(), ctx);
  const payload = ctx.calls[0].payload as { questions: { tier: { criteria: string[] } } };
  assert.deepEqual(payload.questions.tier.criteria, ["easy", "ordinary", "hard"]);
});

test("route: a timed-out classifier falls back to the level and retries next user message", async () => {
  const cfg = config({ classifier: { ...DEFAULTS.classifier!, timeoutMs: 5 } });
  const ctx = registry(
    [],
    (calls) =>
      new Promise((_resolve, reject) => {
        calls.at(-1)!.signal!.addEventListener("abort", () => reject(new Error("classifier timed out")));
      }),
  );
  const first = await routeWith(cfg, userRequest({ thinkingLevel: "low" }), ctx);
  assert.equal(first.model.id, "cheap");
  assert.equal(first.state!.decided, false);

  // A turn already ran on that tier: adopt it instead of re-classifying.
  const second = await routeWith(
    cfg,
    userRequest({ thinkingLevel: "low", previous: { model: { provider: "p", id: "cheap" } }, state: first.state }),
    ctx,
  );
  assert.equal(second.model.id, "cheap");
  assert.equal(second.state!.decided, true);
  assert.equal(ctx.calls.length, 1);
});

test("route: config changes invalidate the saved tier index", async () => {
  const cfg = config();
  const ctx = registry([], () => ({ stopReason: "stop", answers: { tier: { type: "score", score: 0 } } }));
  const stale: State = { tier: 0, floor: 0, decided: true, sig: 12345 };
  const reordered = config({ tiers: [TIERS[1], TIERS[0], TIERS[2]], classifier: DEFAULTS.classifier });
  const result = await routeWith(reordered, userRequest({ state: stale }), ctx);
  assert.equal(ctx.calls.length, 1, "a stale signature must re-decide");
  assert.equal(result.model.id, "cheap");
});

test("route: subagent children skip the classifier and take the cheap tier", async () => {
  const cfg = config({ classifier: DEFAULTS.classifier });
  const ctx = registry();
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    const result = await routeWith(cfg, userRequest({ thinkingLevel: "xhigh" }), ctx);
    assert.equal(result.model.id, "cheap");
    assert.equal(result.state!.decided, true);
    assert.equal(ctx.calls.length, 0);
  } finally {
    delete process.env.PI_SUBAGENT_CHILD;
  }
});

test("route: compaction and other direct requests use the cheap tier", async () => {
  const cfg = config();
  const ctx = registry();
  const result = await routeWith(cfg, { reason: "direct", messages: [], state: undefined }, ctx);
  assert.equal(result.model.id, "cheap");
});

test("route: a quota retry drops a tier and lifts the floor for the session", async () => {
  const cfg = config();
  const ctx = registry();
  const state: State = { tier: 0, floor: 0, decided: true, sig: configSignature(cfg) };
  const result = await routeWith(
    cfg,
    {
      reason: "retry",
      messages: [],
      state,
      failed: {
        provider: "p",
        model: "strong",
        thinkingLevel: "high",
        message: { stopReason: "error", errorMessage: "429 too many requests", provider: "p", model: "strong" },
      },
    },
    ctx,
  );
  assert.equal(result.model.id, "middle");
  assert.equal(result.state!.floor, 1);
});
