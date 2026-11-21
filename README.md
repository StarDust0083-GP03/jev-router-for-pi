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
| 子代理（`router/subagent`） | `subagentTier`，未配置则取最后一档 | 不调用 Jev；不需要检测子进程 |

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
  "subagentTier": 2, // 可省略，默认取最后一档
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

## 子代理：用 `router/subagent`，只在一处配置物理模型

`router/subagent` 直接使用 `tiers[subagentTier]` 的模型和 `thinking`；省略 `subagentTier` 就用最后一档。它不跑 Jev，也不继承主会话选的模型。`pi-subagents`（0.26.2）在同一进程里创建子会话，不设置 `PI_SUBAGENT_CHILD`，也不读 `settings.json` 的 `subagents.defaultModel` / `defaultThinking`，所以这里用显式别名，不检测运行环境。

先确认别名已注册，再修改 agent 文件。否则 `pi-subagents` 可能静默回退到父会话模型。

```bash
pi --offline --list-models router/subagent
# 在仓库目录下运行，为尚未自定义的内置类型生成定义：
node scripts/pin-subagents.mjs
```

脚本为 `general-purpose`、`Explore`、`Plan` 生成完整定义，不覆盖任何已有文件。已有定义只需把 frontmatter 的 `model:` 改为 `router/subagent`，可移除冗余的 `thinking:`；不要重建文件，同名文件会整体替换内置提示和工具配置。修改后 `/reload` 或开新会话。以后换低档，只改 `auto-router.json`。

在 `pi-subagents` 0.26.2 中，普通 `Agent` 调用的 frontmatter 优先于调用参数；Workflow 显式指定 `model` 时可以覆盖。已保存的子会话恢复时通常沿用原模型。仅对显式选择 `router/subagent` 的 agent 生效；其他自定义类型不受影响。

## 已知边界

- **硬配额不会自动降档。** Pi 1.6.0 把 `insufficient_quota`、`quota exceeded`、`billing` 等判成不可重试，单独的 `402` 也不触发重试，路由器根本没机会介入。只有 Pi 判定可重试的错误（429 限流、5xx、overloaded 等）才会走降档。要兜住硬配额，只能手动 `/model`。
- **`/fork`、`/clone` 出来的会话不会被当成子代理。** 没有可靠的进程内标记能区分二者，用一个模糊启发式会把用户的分支悄悄降档，所以宁可不做。
- **首条用户消息会发给分类器。** 最多 `maxPromptChars` 个字符（默认 16000）离开本机去 OpenRouter。敏感内容要么 `classifier: null`，要么直接选物理模型。
- **会话中途不重新判定。** 首条消息轻、后面重时不会自动升档；反过来也不会自动降档。
- **`thinking` 由档位决定，不是你选的等级。** 会话选的 thinking 等级只在分类不可用时用来映射档位；真正发给模型的是每档配的 `thinking`。

## 验证

```bash
npm test        # node --test，无需安装依赖
```

覆盖：配置加载/校验、`score → 档位`、`level → 档位`、配额降级与 floor 单调、floor 对续写的约束（回归）、状态不重复写、配置签名失效后重新判定、分类超时与失败重取、子进程识别、缺失模型的报错。

本地端到端（假 provider + 本地 HTTP 服务，不碰真实额度）：

- 首条消息 → 预期档位；debug 打开能看到 `session tier N (classifier|level fallback, level X)`。
- 高档返回 `429 rate limit` → 观察到第二次请求落到下一档并成功。
- 高档返回 `402 insufficient_quota` → 请求直接失败，**不会**降档（上一条边界的实测依据）。

## 文件

```
src/auto-router.ts          扩展本体（虚拟模型 + 路由逻辑）
auto-router.example.json    全量配置示例
scripts/pin-subagents.mjs   为内置 agent 生成档位别名配置，不覆盖已有文件
test/auto-router.test.ts    路由和配置单测
```

## License

MIT
