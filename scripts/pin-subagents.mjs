#!/usr/bin/env node
/**
 * pin-subagents — give every pi-subagents default agent a model pin.
 *
 * A same-named agent file replaces the built-in definition. Generate the
 * definition only when the file does not already exist, preserving any local
 * edits. By default use the router alias, which owns the physical model and
 * thinking level.
 *
 *   node scripts/pin-subagents.mjs
 *   node scripts/pin-subagents.mjs router/subagent --agents Explore,Plan
 *   node scripts/pin-subagents.mjs provider/model --thinking high --agents Explore,Plan
 *   PI_SUBAGENTS_PKG=/path/to/pi-subagents node scripts/pin-subagents.mjs ... --out /tmp/agents
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const alias = "router/subagent";
const model = argv[0] && !argv[0].startsWith("--") ? argv.shift() : alias;
if (!model.includes("/") || /[\r\n]/.test(model)) {
  console.error("usage: pin-subagents.mjs [provider/model] [--thinking off] [--agents Explore,Plan] [--out DIR]");
  process.exit(2);
}

const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const thinking = flag("thinking", model === alias ? undefined : "off");
if (argv.includes("--thinking") && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) {
  console.error("--thinking requires a valid thinking level");
  process.exit(2);
}
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
let matched = 0;
let skipped = 0;

for (const [name, agent] of DEFAULT_AGENTS) {
  if (only.length > 0 && !only.includes(name)) continue;
  const frontmatter = [`name: ${name}`];
  if (agent.displayName && agent.displayName !== name) frontmatter.push(`display_name: ${quote(agent.displayName)}`);
  frontmatter.push(`description: ${quote(agent.description)}`);
  matched += 1;
  frontmatter.push(`model: ${quote(model)}`);
  if (thinking !== undefined) frontmatter.push(`thinking: ${thinking}`);
  if (agent.builtinToolNames) frontmatter.push(`tools: ${agent.builtinToolNames.join(",")}`);
  frontmatter.push(`prompt_mode: ${agent.promptMode === "append" ? "append" : "replace"}`);
  if (agent.allowedSubagents === "all") frontmatter.push("allowed_subagents: all");

  const body = (agent.systemPrompt ?? "").trim();
  const text = `---\n${frontmatter.join("\n")}\n---\n${body ? `\n${body}\n` : ""}`;
  const file = join(outDir, `${name}.md`);

  try {
    writeFileSync(file, text, { flag: "wx" });
    console.log(`wrote ${file}`);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (readFileSync(file, "utf8") === text) console.log(`same  ${file}`);
    else {
      skipped += 1;
      console.error(`kept ${file}: edit its frontmatter manually to change the model`);
    }
  }
}

if (matched === 0) {
  console.error(`no agent matched ${JSON.stringify(only)}; known: ${[...DEFAULT_AGENTS.keys()].join(", ")}`);
  process.exit(1);
}
if (skipped > 0) process.exitCode = 1;
console.error("start a new pi session (or /reload) so the agent registry is rebuilt");
