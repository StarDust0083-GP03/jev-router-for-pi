#!/usr/bin/env node
/**
 * pin-subagents — give every pi-subagents default agent a model pin.
 *
 * pi-subagents resolves a child's model as: explicit `Agent({ model })` >
 * agent-file frontmatter > parent session. It has no global "default model"
 * setting, and `settings.json` has no `subagents` key, so the only durable place
 * for a default is one `.md` file per agent type.
 *
 * A same-named agent file REPLACES the built-in definition rather than merging
 * into it, so this copies the embedded definition verbatim (description, prompt,
 * tools, prompt mode, delegation) and adds `model:` / `thinking:` on top. Re-run
 * it after upgrading pi-subagents to pick up upstream prompt changes.
 *
 *   node scripts/pin-subagents.mjs commandcode/deepseek/deepseek-v4.1-flash
 *   node scripts/pin-subagents.mjs provider/model --thinking high --agents Explore,Plan
 *   PI_SUBAGENTS_PKG=/path/to/pi-subagents node scripts/pin-subagents.mjs ... --out /tmp/agents
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const model = argv[0];
if (!model || model.startsWith("--") || !model.includes("/")) {
  console.error("usage: pin-subagents.mjs <provider/model> [--thinking off] [--agents Explore,Plan] [--out DIR]");
  process.exit(2);
}

const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const thinking = flag("thinking", "off");
const outDir = resolve(
  flag("out", join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "agents")),
);
const only = flag("agents", "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const packageDir =
  process.env.PI_SUBAGENTS_PKG ||
  join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "npm", "node_modules", "@tintinweb", "pi-subagents");

let DEFAULT_AGENTS;
try {
  ({ DEFAULT_AGENTS } = await import(pathToFileURL(join(packageDir, "dist", "default-agents.js")).href));
} catch (error) {
  console.error(`cannot load ${packageDir}/dist/default-agents.js: ${error.message}`);
  console.error("set PI_SUBAGENTS_PKG to the installed pi-subagents package directory");
  process.exit(1);
}

/** YAML single-quoted scalar: '' is the only escape. */
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

mkdirSync(outDir, { recursive: true });
let written = 0;

for (const [name, agent] of DEFAULT_AGENTS) {
  if (only.length > 0 && !only.includes(name)) continue;
  const frontmatter = [`name: ${name}`];
  if (agent.displayName && agent.displayName !== name) frontmatter.push(`display_name: ${quote(agent.displayName)}`);
  frontmatter.push(`description: ${quote(agent.description)}`);
  frontmatter.push(`model: ${model}`);
  frontmatter.push(`thinking: ${thinking}`);
  if (agent.builtinToolNames) frontmatter.push(`tools: ${agent.builtinToolNames.join(",")}`);
  frontmatter.push(`prompt_mode: ${agent.promptMode === "append" ? "append" : "replace"}`);
  if (agent.allowedSubagents === "all") frontmatter.push("allowed_subagents: all");

  const body = (agent.systemPrompt ?? "").trim();
  const text = `---\n${frontmatter.join("\n")}\n---\n${body ? `\n${body}\n` : ""}`;
  const file = join(outDir, `${name}.md`);

  let previous;
  try {
    previous = readFileSync(file, "utf8");
  } catch {}
  const changed = previous !== text;
  writeFileSync(file, text);
  console.log(`${changed ? "wrote" : "same "} ${file}`);
  written += 1;
}

if (written === 0) {
  console.error(`no agent matched ${JSON.stringify(only)}; known: ${[...DEFAULT_AGENTS.keys()].join(", ")}`);
  process.exit(1);
}
console.error(`pinned ${written} agent(s) to ${model} (thinking ${thinking}) in ${outDir}`);
console.error("start a new pi session (or /reload) so the agent registry is rebuilt");
