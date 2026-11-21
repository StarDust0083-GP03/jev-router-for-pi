/**
 * auto-router — a tiered virtual model for Pi.
 *
 * Registers `router/auto`, a virtual model that picks one of N physical models
 * per session. Tier 0 is the strongest, the last tier the cheapest.
 *
 *   - The tier is decided ONCE per session: the first user message is scored by
 *     an optional classifier, or the selected thinking level is mapped to a
 *     tier. Later messages keep that tier, so the prompt cache survives.
 *   - Follow-ups inside a turn stay on the model that answered.
 *   - Out-of-loop requests (compaction summaries, extension calls) use the cheap
 *     tier.
 *   - `router/subagent` uses the configured subagent tier without classification.
 *     Subprocess launchers can also mark `router/auto` via `subagentEnv`.
 *   - A failed request that Pi retries after a quota / rate-limit error drops
 *     one tier and raises a session floor; no path routes above that floor.
 *
 * Config lives outside the package: `$AUTO_ROUTER_CONFIG`, else
 * `<agentDir>/auto-router.json`, else `<agentDir>/extensions/auto-router.json`
 * (the pre-package location). Missing keys keep the built-in defaults.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRoute,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface TierConfig {
  provider: string;
  id: string;
  /** Thinking level used whenever this tier answers. */
  thinking?: ThinkingLevel;
  /** One line describing the work this tier is for; feeds the classifier scale. */
  when?: string;
}

export interface ClassifierConfig {
  provider: string;
  id: string;
  /** Only this many leading characters of the user message are classified. */
  maxPromptChars: number;
  /** Classification is aborted after this long and the level fallback is used. */
  timeoutMs: number;
}

export interface Config {
  provider: string;
  id: string;
  name: string;
  thinkingLevels: ThinkingLevel[];
  contextWindow?: number;
  maxTokens?: number;
  /** Classifier model, or null to decide from the thinking level only. */
  classifier: ClassifierConfig | null;
  /** Strongest first. The last tier is the cheapest. */
  tiers: TierConfig[];
  /** Thinking level -> tier index for sessions that never reach the classifier. */
  levelTiers: Partial<Record<ThinkingLevel, number>>;
  /** Tier for a level that is not listed. */
  defaultLevelTier: number;
  /** Tier for subagents (default: last tier). */
  subagentTier?: number;
  /** Tier for out-of-loop requests such as compaction summaries. */
  compactTier: number;
  /** Environment variables that mark a subagent child process. */
  subagentEnv: string[];
  /** Log routing decisions and classifier failures to stderr. */
  debug: boolean;
}

export const DEFAULTS: Config = {
  provider: "router",
  id: "auto",
  name: "Auto (3-tier)",
  thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  contextWindow: 272_000,
  maxTokens: 65_536,
  classifier: {
    provider: "openrouter",
    id: "~typesafe/jev-latest",
    maxPromptChars: 16_000,
    timeoutMs: 8_000,
  },
  tiers: [
    {
      provider: "openai-codex",
      id: "gpt-6.2-astra",
      thinking: "high",
      when: "Hard design, cross-cutting refactors, subtle debugging",
    },
    {
      provider: "openai-codex",
      id: "gpt-6.2-sol",
      thinking: "high",
      when: "Ordinary feature work, reviews, debugging with a clear path",
    },
    {
      provider: "commandcode",
      id: "deepseek/deepseek-v4.1-flash",
      thinking: "off",
      when: "Lookups, explanations, small edits, routine chores",
    },
  ],
  levelTiers: { xhigh: 0, max: 0, high: 1, medium: 1, low: 2, minimal: 2, off: 2 },
  defaultLevelTier: 1,
  compactTier: 2,
  subagentEnv: ["PI_SUBAGENT_CHILD"],
  debug: false,
};

/** Provider errors that mean "out of quota" -> use the next tier down. */
const EXHAUSTED =
  /quota|usage|rate.?limit|too many requests|\b429\b|\b402\b|exhaust|credit|balance|insufficient|payment|overloaded|capacity/i;

export interface State {
  /** Tier serving this session. */
  tier: number;
  /** Routing never goes above this tier again in this session. */
  floor: number;
  /** This session already picked a tier; do not classify again. */
  decided: boolean;
  /** Signature of the tier list this state was decided against. */
  sig: number;
}

/** The parts of `request.failed` this router needs. */
export interface FailedRequest {
  model?: { provider: string; id: string };
  message?: { errorMessage?: string };
}

const CONFIG_FILE = "auto-router.json";

/** Pi's agent directory: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** First existing path wins: explicit override, agent dir, pre-package location. */
export function configPath(): string {
  const override = process.env.AUTO_ROUTER_CONFIG;
  if (override) return override;
  const primary = path.join(agentDir(), CONFIG_FILE);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(agentDir(), "extensions", CONFIG_FILE);
  return fs.existsSync(legacy) ? legacy : primary;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

const clampIndex = (tier: number, count: number) => Math.min(Math.max(Math.round(tier), 0), count - 1);

/** Clamp an untrusted index against the tier count. */
export function clampTier(tier: number, count: number): number {
  return Number.isFinite(tier) ? clampIndex(tier, count) : 0;
}

/** djb2 over the tier list: any reorder or replacement invalidates saved indices. */
export function configSignature(cfg: Pick<Config, "tiers">): number {
  const key = cfg.tiers.map((tier) => `${tier.provider}/${tier.id}`).join("|");
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/** Turn a parsed JSON blob into a usable config, keeping defaults for bad fields. */
export function normalizeConfig(raw: unknown, warn: (message: string) => void = () => {}): Config {
  if (!isObject(raw)) {
    warn("config is not an object; using built-in defaults");
    return DEFAULTS;
  }
  const cfg: Config = { ...DEFAULTS };

  for (const key of ["provider", "id", "name"] as const) {
    if (key in raw) {
      if (isNonEmptyString(raw[key])) cfg[key] = raw[key];
      else warn(`${key} must be a non-empty string; keeping ${JSON.stringify(DEFAULTS[key])}`);
    }
  }

  if (cfg.provider === "router" && cfg.id === "subagent") {
    warn("router/subagent is reserved; using router/auto for the main router");
    cfg.id = DEFAULTS.id;
  }

  if ("thinkingLevels" in raw) {
    const levels = Array.isArray(raw.thinkingLevels) ? raw.thinkingLevels.filter(isThinkingLevel) : [];
    if (levels.length > 0) cfg.thinkingLevels = [...new Set(levels)];
    else warn("thinkingLevels must list at least one valid level; keeping the defaults");
  }

  for (const key of ["contextWindow", "maxTokens"] as const) {
    if (key in raw) {
      const value = raw[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) cfg[key] = value;
      else warn(`${key} must be a positive number; keeping ${DEFAULTS[key]}`);
    }
  }

  if (raw.classifier === null) {
    cfg.classifier = null;
  } else if ("classifier" in raw) {
    const spec = isObject(raw.classifier) ? raw.classifier : {};
    const merged = { ...DEFAULTS.classifier! };
    if (isNonEmptyString(spec.provider)) merged.provider = spec.provider;
    else warn("classifier.provider must be a non-empty string; keeping the default");
    if (isNonEmptyString(spec.id)) merged.id = spec.id;
    else warn("classifier.id must be a non-empty string; keeping the default");
    if (typeof spec.maxPromptChars === "number" && spec.maxPromptChars > 0) merged.maxPromptChars = Math.floor(spec.maxPromptChars);
    if (typeof spec.timeoutMs === "number" && spec.timeoutMs > 0) merged.timeoutMs = Math.floor(spec.timeoutMs);
    cfg.classifier = merged;
  }

  if ("tiers" in raw) {
    const tiers: TierConfig[] = [];
    for (const [index, tier] of (Array.isArray(raw.tiers) ? raw.tiers : []).entries()) {
      if (!isObject(tier) || !isNonEmptyString(tier.provider) || !isNonEmptyString(tier.id)) {
        warn(`tiers[${index}] needs string provider and id; skipped`);
        continue;
      }
      const entry: TierConfig = { provider: tier.provider, id: tier.id };
      if (isThinkingLevel(tier.thinking)) entry.thinking = tier.thinking;
      else if (tier.thinking !== undefined) warn(`tiers[${index}].thinking is not a valid level; using the provider default`);
      if (isNonEmptyString(tier.when)) entry.when = tier.when;
      tiers.push(entry);
    }
    if (tiers.length > 0) cfg.tiers = tiers;
    else warn("tiers is empty or invalid; keeping the built-in tiers");
  }

  if ("levelTiers" in raw) {
    const levelTiers: Partial<Record<ThinkingLevel, number>> = {};
    for (const [level, tier] of Object.entries(isObject(raw.levelTiers) ? raw.levelTiers : {})) {
      if (!isThinkingLevel(level)) {
        warn(`levelTiers.${level} is not a thinking level; ignored`);
        continue;
      }
      if (typeof tier === "number" && Number.isFinite(tier)) levelTiers[level] = clampTier(tier, cfg.tiers.length);
      else warn(`levelTiers.${level} must be a number; ignored`);
    }
    cfg.levelTiers = levelTiers;
  }

  for (const key of ["defaultLevelTier", "subagentTier", "compactTier"] as const) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) cfg[key] = clampTier(value, cfg.tiers.length);
    else warn(`${key} must be a number; keeping ${DEFAULTS[key] ?? "the last tier"}`);
  }

  if ("subagentEnv" in raw) {
    const names = Array.isArray(raw.subagentEnv) ? raw.subagentEnv : [];
    if (names.every(isNonEmptyString)) cfg.subagentEnv = [...names];
    else warn("subagentEnv must be a list of environment variable names; keeping the defaults");
  }

  if ("debug" in raw) {
    if (typeof raw.debug === "boolean") cfg.debug = raw.debug;
    else warn("debug must be true or false; keeping false");
  }

  return cfg;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.error(`[auto-router] ${message}`);
}

/** Read the config file, keeping defaults for anything it leaves out. */
export function loadConfig(file = configPath()): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnOnce(`ignoring ${file}: ${(error as Error).message}`);
    }
    return DEFAULTS;
  }
  return normalizeConfig(raw, warnOnce);
}

/** Tier index of a physical model this router owns, if any. */
export function tierOf(model: { provider: string; id: string } | undefined, cfg: Config): number | undefined {
  if (!model) return undefined;
  const index = cfg.tiers.findIndex((tier) => tier.provider === model.provider && tier.id === model.id);
  return index === -1 ? undefined : index;
}

/** Tier for a thinking level when the classifier is unavailable. */
export function tierFromLevel(level: string | undefined, cfg: Config): number {
  const listed = level && isThinkingLevel(level) ? cfg.levelTiers[level] : undefined;
  return clampTier(listed ?? cfg.defaultLevelTier, cfg.tiers.length);
}

/** Classifier score (0 = simplest .. tiers-1 = hardest) -> tier index. */
export function tierFromScore(score: number, cfg: Config): number {
  return clampTier(cfg.tiers.length - 1 - score, cfg.tiers.length);
}

/** Where a failed request goes: same tier, or one tier down after quota exhaustion. */
export function planRetry(state: State, failed: FailedRequest | undefined, cfg: Config): State {
  if (!failed) return state;
  const tier = tierOf(failed.model, cfg) ?? state.tier;
  if (!EXHAUSTED.test(failed.message?.errorMessage ?? "")) return { ...state, tier: clampTier(tier, cfg.tiers.length) };
  const next = clampTier(tier + 1, cfg.tiers.length);
  return { ...state, tier: next, floor: Math.max(state.floor, next) };
}

/** Whether this process is a subagent child session. */
export function isSubagentSession(cfg: Config, env: NodeJS.ProcessEnv = process.env): boolean {
  return cfg.subagentEnv.some((name) => {
    const value = env[name];
    return Boolean(value) && value !== "0" && value !== "false";
  });
}

export function sameState(a: State | undefined, b: State): boolean {
  return a !== undefined && a.tier === b.tier && a.floor === b.floor && a.decided === b.decided && a.sig === b.sig;
}

function lastUserText(messages: readonly Message[]): string {
  const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Ask the classifier which tier fits the request. Undefined when unavailable. */
export async function classifyTier(
  request: Pick<ModelRouteRequest<State>, "messages" | "signal">,
  ctx: Pick<ExtensionContext, "modelRegistry">,
  cfg: Config,
): Promise<number | undefined> {
  const spec = cfg.classifier;
  if (!spec) return undefined;
  const classifier = ctx.modelRegistry.findOfType("classifier", spec.provider, spec.id);
  if (!classifier) {
    if (cfg.debug) console.error(`[auto-router] classifier ${spec.provider}/${spec.id} not found in the catalog`);
    return undefined;
  }
  const prompt = lastUserText(request.messages).slice(0, spec.maxPromptChars);
  if (!prompt.trim()) return undefined;
  const timeout = AbortSignal.timeout(spec.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  try {
    const result = await ctx.modelRegistry.classify(
      classifier,
      {
        state: { request: prompt },
        questions: {
          tier: {
            type: "score",
            instructions:
              "How demanding is the software engineering work requested in `request`? Answer on this scale.",
            // Lowest first, so the last tier's description is the hardest work.
            criteria: [...cfg.tiers].reverse().map((tier) => tier.when ?? `${tier.provider}/${tier.id}`),
          },
        },
      },
      { signal },
    );
    const answer = result.stopReason === "stop" ? result.answers.tier : undefined;
    if (cfg.debug) {
      console.error(
        `[auto-router] classify ${JSON.stringify({ stopReason: result.stopReason, error: result.errorMessage, answer })}`,
      );
    }
    return answer?.type === "score" ? tierFromScore(answer.score, cfg) : undefined;
  } catch (error) {
    if (cfg.debug) console.error(`[auto-router] classify failed: ${(error as Error).message}`);
    return undefined;
  }
}

function resolveTier(ctx: Pick<ExtensionContext, "modelRegistry">, cfg: Config, index: number) {
  const { provider, id, thinking } = cfg.tiers[index];
  const model = ctx.modelRegistry.find(provider, id);
  if (!model) {
    throw new Error(
      `auto-router: ${provider}/${id} (tier ${index}) is not in the catalog. ` +
        `Fix the tier in ${configPath()}, or check that provider's credentials.`,
    );
  }
  return { model, thinkingLevel: thinking };
}

/** Resolve a session route after applying the floor. */
export function pick(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  cfg: Config,
  tier: number,
  floor: number,
  decided: boolean,
  sig: number,
  previous: State | undefined,
): ModelRoute<State> {
  const index = clampTier(Math.max(tier, floor), cfg.tiers.length);
  const next: State = { tier: index, floor: clampTier(floor, cfg.tiers.length), decided, sig };
  // Pi appends a state entry whenever route() returns a new object; stay quiet when nothing moved.
  return { ...resolveTier(ctx, cfg, index), state: sameState(previous, next) ? undefined : next };
}

function register(pi: ExtensionAPI, cfg: Config): void {
  const sig = configSignature(cfg);
  const subagentTier = cfg.subagentTier ?? cfg.tiers.length - 1;
  pi.registerVirtualModel({
    provider: "router",
    id: "subagent",
    name: "Subagent tier",
    route(_request, ctx) {
      return resolveTier(ctx, cfg, subagentTier);
    },
  });
  pi.registerVirtualModel<State>({
    provider: cfg.provider,
    id: cfg.id,
    name: cfg.name,
    thinkingLevels: cfg.thinkingLevels,
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
    async route(request, ctx) {
      const subagent = isSubagentSession(cfg);
      const fresh: State = {
        tier: subagent ? subagentTier : cfg.defaultLevelTier,
        floor: subagent ? subagentTier : 0,
        decided: subagent,
        sig,
      };
      // A saved index only means something against the tier list it was decided on.
      const state = request.state?.sig === sig ? request.state : fresh;

      // Compaction summaries and other out-of-loop requests: cheap tier.
      if (request.reason === "direct") {
        return pick(ctx, cfg, cfg.compactTier, state.floor, state.decided, sig, request.state);
      }

      if (request.reason === "retry") {
        const next = planRetry(state, request.failed as FailedRequest | undefined, cfg);
        return pick(ctx, cfg, next.tier, next.floor, next.decided, sig, request.state);
      }

      // Follow-ups inside a turn stay on the answering model (prompt cache).
      if (request.reason !== "user") {
        const tier = tierOf(request.previous?.model, cfg) ?? state.tier;
        return pick(ctx, cfg, tier, state.floor, state.decided, sig, request.state);
      }

      // The session already picked a tier.
      if (state.decided) return pick(ctx, cfg, state.tier, state.floor, true, sig, request.state);

      // A turn already ran on this tier (the classifier failed earlier): keep it
      // instead of re-classifying mid-session and paying for a cache miss.
      if (request.previous) return pick(ctx, cfg, state.tier, state.floor, true, sig, request.state);

      // First user message of the session: classify once. A failed classification
      // stays undecided, so the next user message can try again.
      const classified = await classifyTier(request, ctx, cfg);
      const tier = classified ?? tierFromLevel(request.thinkingLevel, cfg);
      if (cfg.debug) {
        console.error(
          `[auto-router] session tier ${tier} (${classified === undefined ? "level fallback" : "classifier"}, level ${request.thinkingLevel})`,
        );
      }
      return pick(ctx, cfg, tier, state.floor, classified !== undefined, sig, request.state);
    },
  });
}

export default function (pi: ExtensionAPI) {
  register(pi, loadConfig());
  // Re-read the config file so edits apply to the next session.
  pi.on("session_start", () => register(pi, loadConfig()));
}
