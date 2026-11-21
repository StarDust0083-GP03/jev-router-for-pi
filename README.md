# jev-router-for-pi

给 Pi 用的**分档虚拟模型** `router/auto`：一个会话只判定一次档位，最强的模型干重活，最便宜的模型干杂活。

- 第 0 档最强，最后一档最便宜，档数随你配。
- 首条用户消息交给分类器（默认 Jev）打一次分，整场会话固定用这一档。
- 同一回合的工具续写留在应答模型上，不吃缓存 miss。
- compact、摘要等 loop 外请求直接走最便宜档。
- 遇到 Pi 判定可重试的配额/限流错误，降一档重试，并把该会话的档位下限（floor）顶住。

```bash
pi install git:github.com/StarDust0083-GP03/jev-router-for-pi
cp auto-router.example.json ~/.pi/agent/auto-router.json   # 然后按需改
pi --model router/auto
```

想让它成为默认模型：

```jsonc
// ~/.pi/agent/settings.json
{
  "defaultProvider": "router",
  "defaultModel": "auto",
  "enabledModels": ["router/auto", "openai-codex/gpt-6.2-astra", "commandcode/deepseek/deepseek-v4.1-flash"]
}
```

---

## 方案

### 判定时机

| 请求来源 | 用哪一档 | 原因 |
|---|---|---|
| 会话第一条用户消息 | 分类器打分 → 档位 | 只判断一次，避免每条消息换模型导致缓存全废 |
| `state.decided` 已为真 | 会话已定的档位 | 同上 |
| 同一回合的工具续写（`continuation`） | 上一轮应答的档位 | 保留 prompt cache 与 thinking 签名 |
| 自动重试（`retry`） | 上次失败档位；是配额错误就降一档 | 用价格换可用性，并把 floor 顶到下不去 |
| compact / 扩展调用（`direct`） | `compactTier` | 摘要是纯机械活，没必要用强模型 |
| 子进程子会话 | `subagentTier` | 由 `subagentEnv` 标记（默认 `PI_SUBAGENT_CHILD`） |

分类器失败、超时、模型不在目录里时，回退到**会话当前选的 thinking 等级**映射的档位（`levelTiers`），不阻塞请求。

### 档位就是配置

```jsonc
{
  "classifier": { "provider": "openrouter", "id": "~typesafe/jev-latest",
                  "maxPromptChars": 16000, "timeoutMs": 8000 },  // 设 null 就纯按 thinking 等级走
  "tiers": [
    { "provider": "openai-codex", "id": "gpt-6.2-astra", "thinking": "high",
      "when": "Hard design, cross-cutting refactors, subtle debugging" },
    { "provider": "openai-codex", "id": "gpt-6.2-sol",   "thinking": "high", "when": "..." },
    { "provider": "commandcode",  "id": "deepseek/deepseek-v4.1-flash", "thinking": "off", "when": "..." }
  ],
  "levelTiers": { "xhigh": 0, "max": 0, "high": 1, "medium": 1, "low": 2, "minimal": 2, "off": 2 },
  "defaultLevelTier": 1,
  "subagentTier": 2,
  "compactTier": 2,
  "debug": false
}
```

`tiers` 顺序固定为从强到弱：第 0 档最强，最后一档最便宜。每档的 `when` 会被拼成分类器的评分刻度（**最便宜的排第一**，分数 0 = 最简单，`len-1` = 最难），所以加一档、减一档都不用改代码。

配置位置，按优先级：

1. `$AUTO_ROUTER_CONFIG`
2. `~/.pi/agent/auto-router.json`（推荐；`PI_CODING_AGENT_DIR` 优先）
3. `~/.pi/agent/extensions/auto-router.json`（旧位置，兼容）

配置**不放在包目录里**，否则包升级会覆盖你的设置。改完新会话生效；当前会话 `/reload` 会重读。

### 为什么不是"每条消息都判一次"

省的是两笔钱：分类器调用，以及换模型带来的 prompt cache 重建。一个会话里模型来回切换，等于每切一次都把很长的系统提示和对话重新按全价写一遍缓存，省下的算力经常还不够付这笔。代价是"开头轻、后面重"的会话会一直在低档。这个取舍是明确的：需要时手动 `/model` 切强档，不要让路由器替你在会话中途猜。

### 为什么 floor 在 `pick()` 里兜底

`floor` 表示"这个会话不要再往上走"，也就是档位索引只能**大于等于** floor。它必须对每一条路径都成立，否则一条 `continuation` 就能把已耗尽的强档又拉回来，而且会把这个档位写回状态，后续消息继续踩。

所以现在只有 `pick()` 一个出口做 `Math.max(tier, floor)`，用户消息、续写、重试、compact 全部经过它。单测里有一条专门的回归用例：`tier=0, floor=2` 的续写必须落到第 2 档。

### 为什么状态里带 `sig`

Pi 把路由状态存在会话分支里，重启、fork、`/tree` 都会带回来。但状态里的 `tier` 是**数组下标**：你重排或替换了 `tiers` 之后，同一个下标就指向了另一个模型，旧 `floor` 的含义也变了。

`state.sig` 是 tier 列表（provider/id 拼起来）的 djb2 哈希。签名不一致就丢弃旧决策，下一条用户消息重新判定一次。这样改配置不会静默用错模型，也不会把用户自己 fork 出来的分支带偏。

### 为什么分类要有超时

分类器在首 token 之前同步跑，没有预算就是"卡住不动"。默认 8 秒（`classifier.timeoutMs`），超时按失败处理。失败不算"已决策"：如果这一轮根本没有产出成功回复，下一条用户消息会重新分类；如果已经在回退档位上跑完过一轮，就直接认这个档位，不再中途换模型。

### 配置校验

`tiers` 里缺 `provider`/`id`、`thinking` 写着不存在的等级、`levelTiers` 越界、`classifier` 缺字段：这些都会跳过并打一行警告，其余字段继续用默认值。旧版直接 `{...DEFAULTS, ...raw}` 强转，一个手滑的空数组就能让 `pick()` 在后面崩掉。

模型在目录里找不到时，错误信息会带上 `provider/id`、档位索引和配置文件路径，而不是一句 `Cannot read properties of undefined`。

---

## 子代理：为什么配置里写了也不生效

`PI_SUBAGENT_CHILD` 只对**独立进程**的子会话有效。`pi-subagents`（0.26.2）是在同一进程里 `createAgentSession()` 起子会话的，既不设置这个环境变量，也不读 `settings.json` 里的 `subagents.defaultModel` / `defaultThinking`——pi 1.6.0 的设置里也根本没有 `subagents` 这一项。所以那两个键是摆设。

子会话的真实优先级是：**调用时 `model:` > agent 文件 frontmatter > 父会话模型**。也就是说，父会话用 `router/auto` 时，子会话继承的也是 `router/auto`，然后**自己再判一次档**——这才是子代理费用的实际走向。

要让它便宜，唯一稳的地方是 agent 文件的 frontmatter：

```markdown
---
name: Explore
description: ...
model: commandcode/deepseek/deepseek-v4.1-flash
thinking: off
---
```

注意同名 agent 文件是**整个替换**内置定义，不是合并；只写三行 frontmatter 会把内置的只读提示和工具限制一起丢掉。做法是把 `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents/src/default-agents.ts` 里对应 agent 的完整定义复制成 `~/.pi/agent/agents/Explore.md`，再加 `model`/`thinking` 两行。

`Agent` 工具调用的 `model` 参数也能临时指定，优先级最高，适合一次性任务。

读不到上面这些，就记住一句：**子代理便宜不便宜，看 agent 文件，不看路由器配置。**

## 已知边界

- **硬配额不会自动降档。** Pi 1.6.0 把 `insufficient_quota`、`quota exceeded`、`billing` 等判成不可重试，单独的 `402` 也不触发重试，路由器根本没机会介入。只有 Pi 判定可重试的错误（429 限流、5xx、overloaded 等）才会走降档。要兜住硬配额，只能手动 `/model`。
- **`/fork`、`/clone` 出来的会话不会被当成子代理。** 没有可靠的进程内标记能区分二者，用一个模糊启发式会把用户的分支悄悄降档，所以宁可不做。
- **首条用户消息会发给分类器。** 最多 `maxPromptChars` 个字符（默认 16000）离开本机去 OpenRouter。敏感内容要么 `classifier: null`，要么直接选物理模型。
- **会话中途不重新判定。** 首条消息轻、后面重时不会自动升档；反过来也不会自动降档。
- **`thinking` 由档位决定，不是你选的等级。** 会话选的 thinking 等级只在分类不可用时用来映射档位；真正发给模型的是每档配的 `thinking`。

## 验证

```bash
npm test        # 25 条，node --test，无需安装依赖
```

覆盖：配置加载/校验、`score → 档位`、`level → 档位`、配额降级与 floor 单调、floor 对续写的约束（回归）、状态不重复写、配置签名失效后重新判定、分类超时与失败重取、子进程识别、缺失模型的报错。

本地端到端（假 provider + 本地 HTTP 服务，不碰真实额度）：

- 首条消息 → 预期档位；debug 打开能看到 `session tier N (classifier|level fallback, level X)`。
- 高档返回 `429 rate limit` → 观察到第二次请求落到下一档并成功。
- 高档返回 `402 insufficient_quota` → 请求直接失败，**不会**降档（上一条边界的实测依据）。

## 文件

```
src/auto-router.ts       扩展本体（虚拟模型 + 路由逻辑）
auto-router.example.json 全量配置示例
test/auto-router.test.ts 25 条单测
```

## License

MIT
