# Claude Hermes

> **Fork 自 [moazbuilds/claudeclaw](https://github.com/moazbuilds/claudeclaw)。** 围绕 SQLite 状态引擎、基于 envelope 的 router、自动晋升的 skills pipeline 和人触发 + verify 把关的自我进化 loop 重构。对外只保留 Telegram 和 Discord 两个入口 — 没有 Web dashboard。

> 🇬🇧 [English README](README.md)

Claude Hermes 把你的 Claude Code 变成一个不睡觉的个人助理：后台 daemon 常驻，按 schedule 执行任务，在 Telegram 和 Discord 上接话，转写语音命令，还会从你的使用中自己学新 skills。

## 为什么是 Hermes（相对它 fork 来的 Claw）

| | Hermes | Claw |
| --- | --- | --- |
| 存储 | `bun:sqlite` + FTS5，单文件 `state.db` | 一堆 JSON 文件 |
| Session | 按 scope 路由（`dm`, `per-channel-user`, `per-thread`, `shared`, `workspace`） | 全局 session + per-thread 覆盖 |
| Skills | candidate → active，带 rollback 窗口（回退时落到 `shadow`） | 只能手动装 |
| 自我进化 | 人触发 + verify 把关：绿了自动 commit，红了 revert | 无 |
| 模型路由 | agentic 模式按每条消息挑 Opus 做 planning / Sonnet 做 implementation | 单模型 |
| Web dashboard | 砍掉了 — 只走 Telegram/Discord/CLI | 有 |
| Verify pipeline | typecheck + lint + unit + smoke + integration，五个全绿才算过 | 手动 |

## 安装

最省事的路子 — 从 Claude Code plugin marketplace 装。在任意 Claude Code session 里跑：

```
/plugin marketplace add sypsyp97/claude-hermes
/plugin install claude-hermes@claude-hermes
/claude-hermes:start
```

setup wizard 会一路引导你配 model、heartbeat、Telegram、Discord 和 security；配完 daemon 就在后台跑起来了。唯一的 runtime 依赖是 Bun — 如果没装，`start` 会问你要不要自动装一个。

如果这个 workspace 之前跑过上游的 Claw daemon，第一次 `start` 会把 `.claude/claudeclaw/` 一次性迁移到 `.claude/hermes/`，老目录原样留着当保险。

### 从源码开发

```bash
git clone https://github.com/sypsyp97/claude-hermes.git
cd claude-hermes
bun install
bun run verify
```

然后让 Claude Code 指向这个 working tree：

```
/plugin marketplace add /absolute/path/to/claude-hermes
/plugin install claude-hermes@claude-hermes
```

## 功能

### 自动化
- **Heartbeat：** 周期性的 check-in，可以配 interval、quiet hours、改 prompt。heartbeat prompt 可以是 inline string 也可以是文件路径；改了不用重启 daemon。
- **Cron jobs：** 带时区的定时任务，支持周期性和一次性。job 文件每 30s 热加载一次 — 不需要重启 daemon。
- **Scaffolder（`/claude-hermes:new`）：** `new job <name>`、`new skill <name>`、`new prompt <name>` 会用合理的 frontmatter 默认值生成模板文件，不用手搓 YAML。也能当 CLI 用：`bun run src/index.ts new job my-job --schedule "0 9 * * *"`。
- **自我进化（`bun run scripts/evolve.ts`）：** 可选的本地工具。你丢一段任务描述（CLI 参数、stdin 或 Discord/Telegram 消息），它让本地 Claude 去实现，全套 verify 跑完，绿了 commit、红了 `git restore`。小步走、verify 把关、全程写 journal。完全人触发，没有 cron — verify 就是安全网。

### 通信
- **Telegram：** 支持文字、图片、语音（whisper.cpp 或任意 OpenAI 兼容的 STT endpoint）。
- **Discord：** DM、服务器 @mention/reply、slash 命令（`/start`、`/reset`）、语音消息、图片附件、reaction 反馈。
- **时间感知：** 消息里带时间戳前缀，帮 agent 理解延迟和日常节奏。
- **实时 status sink：** 任务进度会实时推给触发它的人 — Discord 加 reaction、Telegram 发 typing、terminal 打日志 — 跑得慢的 `evolve` 或 heartbeat turn 不会哑巴。

### Discord 频道策略
daemon 按频道名自动路由：
- **`listen-*` / `ask-*`** — 自由回应模式，不用 @mention 也会答。
- **`deliver-*`** — 只投递，不交互回复（适合广播）。
- **普通服务器频道** — 默认：per-channel-user 记忆，只在被 @mention 或 reply 时回。
- **DM** — 默认：per-user 记忆，每条都回。
- **手动 override：** SQLite 里 `channel_policies` 的 per-channel 配置优先于按名字推断的默认值。

### Discord 多 session 线程
- **独立 thread session：** 每个 Discord thread 拿自己的 Claude CLI session。
- **并行处理：** 不同 thread 里的消息互不阻塞。
- **自动创建：** 一个新 thread 的第一条消息会 bootstrap 一个新 session。
- **清理：** thread 被删或归档，对应的 session 也一起扔掉。
- **向后兼容：** DM 和主频道消息还是走全局 session。

细节看 [docs/MULTI_SESSION.md](docs/MULTI_SESSION.md)。

### 可靠性与控制
- **Agentic 模型路由：** 每个 turn 按关键词/短语分类成 `planning`（→ Opus）或 `implementation`（→ Sonnet）。modes 在 `settings.json` 里可配；关掉就固定用单一模型。
- **模型 fallback：** 主模型撞 rate limit 时，自动用备用模型重试（推荐用 GLM 换 provider path 更稳）。
- **Security 级别：** 四档工具访问权限，全都是 headless（不会弹权限 prompt）：
  - `locked` → 只能 `Read`、`Grep`、`Glob`；限定在项目目录。
  - `strict` → 除 `Bash`、`WebSearch`、`WebFetch` 以外全开；限定在项目目录。
  - `moderate` → 所有工具；限定在项目目录。
  - `unrestricted` → 所有工具，不限目录。
- **Skill 自动晋升：** 在 7 天窗口内跑过 ≥20 次且成功率 ≥85% 的 candidate skill 自动升到 `active`。升上去后如果 rollback 窗口里成功率掉到 70% 以下，就被降回 `shadow`。阈值在 `src/learning/config.ts` 里，可调。
- **Evolve 安全守则：** 自改子 agent 的 system prompt 永远前置一套硬规则 —— 禁 `git stash`、禁切分支、禁 `--no-verify`、禁 force push、禁写 cwd 外的文件。守则内容在 `prompts/EVOLVE_GUARDS.md`，丢失时还有保守的 inline fallback 兜底，永远不会静默失效。
- **抗崩溃的 daemon registry：** `~/.claude/hermes/daemons.json` 用 tmp-write + rename 原子写，SIGKILL 打断写入也不会把 registry 抹掉。
- **父 daemon 保护：** 从 daemon 自己的 Claude 子进程里调 `/stop`、`/stop-all`、`/clear`，永远不会干掉正在跑自己的那个 daemon。
- **Rate-limit 重试：** Discord 加 reaction 的 PUT 走统一的 `discordApi` helper，碰到 429 会按 `Retry-After` 重试，不会像之前那样默默丢弃。

## 记忆系统

分三层，稳定性从高到低排：

**1. Identity（markdown，人可编辑，cache 友好的前缀）**
- `prompts/{IDENTITY,USER,SOUL}.md` —— 仓库级模板，进 git。
- 项目根 `CLAUDE.md` —— per-project 指令。
- `.claude/hermes/memory/{SOUL,IDENTITY,USER}.md` —— 每个 workspace 的覆盖。

这些组成每次 `--append-system-prompt` 的稳定头部，**要跨轮保持字节相同**，CLI 的 prompt cache 才会命中。sanitization 规则见 [`src/memory/compose.ts`](src/memory/compose.ts)：`MEMORY.md` 里的 ISO 时间戳标记被剥掉，超 byte cap 时从头部开始丢最老条目，前缀里不留任何易变内容。

**2. Episodic state（SQLite，只追加，FTS 索引）**
- `state.db` → `messages` 表，每轮成功调用由 `persistTurn` 写入。每行带 `importance`（1–10，启发式定：user=6、assistant=5、tool=3、system=4，每个 `remember` / `todo` / `?` 命中 +2，封顶 10）、`last_access`、`digested_at`。
- FTS5 虚拟表：`messages_fts` 用于跨会话搜索，`skill_descriptions_fts` 用于 skill 检索。
- Park 式打分（`α·recency + β·importance + γ·relevance`，`recency = exp(-h/24)`）在 `src/memory/scoring.ts`；`searchWithScoring` 返回按分排序的命中。

**3. Primitives（现在都接进 runtime 了，但要么 opt-in、要么人工 gate）**
- **Letta 式 blocks**（`src/memory/blocks.ts`）—— 标签 slot（`persona` / `human` / `project` / `channel:<id>`）带硬字符预算，超预算直接抛错，不会偷偷截断。`.claude/hermes/memory/blocks/` 下的所有 block，runner 在每一轮都加载，按字母顺序以 `<block:NAME>…</block>` 框架打进 system prompt — 每次 spawn 都看得见。
- **Anthropic `memory_20250818` 六操作 API**（`src/memory/agent-memory.ts`）—— `view / create / strReplace / insert / del / rename`，全部限定在 `.claude/hermes/memory/agent/` 内。路径穿越由单一门禁 `resolveAgentPath` 挡下。Composer 在每一份 prompt 末尾追加一段 hint，告诉 agent 这个 scratchpad 存在以及哪些 op 可用；`dispatchAgentMemory`（在 `agent-memory-dispatch.ts`）把六个 op 压成一个 JSON 形状的统一入口，返回 `{ ok, result?, error? }`。
- **Honcho 式 Dream cron**（`src/memory/dream.ts`、`src/memory/dream-scheduler.ts`）—— `runDream` 把超过 `ageDays` 的老消息压缩成 per-session 摘要、去重 `MEMORY.md` 里的相同条目（保留最新的）、把冲突条目加 `<!-- invalidated -->` 标记（不删）。daemon 60s cron tick 每次都调 `maybeRunDream`；按 `dreamIntervalHours` 限速（默认 24h，状态存在 `kv` 表里，重启后还在）。开关是 `settings.memory.dreamCron`（默认 false）。幂等，纯启发式，无 LLM 调用。
- **Voyager 式 skill library**（`src/skills/library.ts`）—— skill 目录布局 `<name>/{SKILL.md, description.txt, trajectory.jsonl}`，写在 `.claude/hermes/skills/` 下；`description.txt` 上跑 FTS5 检索，写入前过 `src/skills/validate.ts` 的 manifest 校验。`active` 行由 `syncActiveSkills`（`src/skills/bridge.ts`）镜像到 `.claude/skills/hermes_<name>/` 让 Claude Code 内置的 skill 发现机制识别；非 active 行不会被镜像。
- **Closed learning loop primitives**（`src/learning/closed-loop.ts`）—— `proposeSkillFromTrajectory` 把 `(prompt, reply, tools)` 轨迹压成候选 manifest，`promoteIfVerified` 只有在调用方传的 `runVerify()` 返回 true 时才把候选从 `candidate` 推到 `shadow`。runner 现在每一轮成功之后都会把轨迹喂给 `captureCandidateSkill`（`src/learning/completion-hook.ts`），但**永远停在 `candidate`**：候选写到磁盘 + DB，绝不会自动升 shadow 或 active。升级是人的事。开关是 `settings.learning.captureCandidateSkills`（默认 false）；已有的 shadow / active 行不会被重复抓取覆盖。

### 现在每一轮实际发生什么

1. `execClaude` 拼 appended system prompt：`"You are running inside Claude Hermes."` + repo 模板 + 项目 `CLAUDE.md` + `composeSystemPrompt({memoryScope: "workspace", blocks: readAllBlocks(), includeAgentMemoryHint: true})`（sanitize + tail-truncate MEMORY.md、按字母顺序打出所有 block、末尾附一段 agent-memory hint） + 目录越权守则。
2. Claude 跑起来，事件流推给 sink（Discord/Telegram/terminal 状态）。
3. `exitCode === 0` 时 `persistTurn` upsert session 行，并把 user + assistant 两条消息写进 `messages`（自动打 importance 分，FTS5 索引自动更新）。
4. 如果 `settings.learning.captureCandidateSkills` 打开，runner 后台 fire-and-forget 地调一次 `captureCandidateSkill` —— 非平凡轨迹落地成 `candidate` 行 + Voyager 文件，绝不自动升级。
5. daemon 60s cron tick 调 `maybeRunDream`（被 `settings.memory.dreamCron` gate 住）和 `syncActiveSkills`，这样 digest 保持 up-to-date、人工晋升的 skill 一分钟之内就能被 spawn 出来的 agent 看到，不用重启 daemon。
6. 持久化 / sidecar 环节任何异常都被吞掉 —— 回复照常返回给用户。

## Verify pipeline

`bun run verify` 跑五个 stage，任何一个红都算失败：

```
typecheck → lint → unit → smoke → integration
```

自我进化 loop 只在五个全绿的时候 commit；否则 `git restore` 回去，重开一条 journal。开发内循环可以用 `bun run verify --fast`（只跑 typecheck + unit）。

## 开发

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # biome check src tests scripts
bun run fmt         # biome format --write
bun test src        # unit tests
bun test tests/smoke
bun test tests/integration
```

## 致谢

Telegram bridge、Discord bridge、语音转写和最早的 cron/heartbeat 骨架都来自 [moazbuilds/claudeclaw](https://github.com/moazbuilds/claudeclaw)。skills loop 的进化节奏参考了 [yologdev/yoyo-evolve](https://github.com/yologdev/yoyo-evolve)。
