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
- **抗崩溃的 daemon registry：** `~/.claude/hermes/daemons.json` 用 tmp-write + rename 原子写，SIGKILL 打断写入也不会把 registry 抹掉。
- **父 daemon 保护：** 从 daemon 自己的 Claude 子进程里调 `/stop`、`/stop-all`、`/clear`，永远不会干掉正在跑自己的那个 daemon。
- **Rate-limit 重试：** Discord 加 reaction 的 PUT 走统一的 `discordApi` helper，碰到 429 会按 `Retry-After` 重试，不会像之前那样默默丢弃。

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
