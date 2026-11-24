# Vestigio 运行时可观测性记录开发计划

本计划承接 2026-11-24 的可观测性走查，目标是把下面六类运行数据落到磁盘，先不做仪表盘，用类似 `eval/memory/audit.mjs` 的脚本查看，方便后续分析问题。

六项需求原文：

1. 每个 agent 运行记录的 jsonl，上限 512M，超过时删除旧的内容。
2. 接口的调用次数以及不同状态结果的占比。
3. 每个 agent 的总、平均 token 消耗量。
4. 每个 agent 的总、平均运行耗时。
5. memory 的注入次数以及注入概率。
6. 总记忆量、临时记忆数、临时记忆池占用率。

约束原文：有些比较消耗磁盘和性能的项目需要开启调试功能才行；先不做仪表盘，只把数据记录下来。

本文件只记录方案，执行等本轮讨论后的明确开始指令。

## 0. 本轮讨论已定

- **第 1 项只记 vestigio 内部模型调用的上下文。** 主 agent 的会话上下文 pi 已经逐条保存，本计划不重复保存。要记的是 resolver/judge/extraction/detector/nav 的模型调用上下文，用普通 JSONL，不需要树状分叉支持。这类日志含提示词与模型回复正文，属于要开调试开关的项目。
- **一个 invocation 的 N 轮放同一个文件。** 见 2.2 的理由。resolve 的一个 invocation 就是一次决策，N 轮是这次决策的 N 个模型调用，不拆成 3 个文件。
- **Q1“临时记忆”取当前 hotspot 池成员。** “临时记忆数” = 该 project 的 `readHotspotMemberships(project_id).length`，“临时记忆池占用率” = 成员数 / `pool_capacity`（默认 `DEFAULT_HOTSPOT_POOL_CAPACITY = 32`）。
- **Q2 “接口”只算 vestigio 自己的面。** 即 pi 侧 memory 工具加 daemon HTTP。LLM provider API 的调用与状态已由 pi 自己的 telemetry 覆盖，不重复采集。
- **Q3 注入概率用精确分母。** 新增一张 always-on 的逐 turn 行给概率一个干净分母，理由见 2.5。

## 1. 已有 / 轻微改进 / 从零

先给结论。六项里大部分数据源已经在仓库或 pi 里存在，唯一需要新增的存储结构是逐 turn 行，其余是新增日志文件与查询。

| 需求 | 已有 | 只需轻微改进 | 需要从零 |
| --- | --- | --- | --- |
| 1 模型调用上下文日志 | `ModelPort` 已是唯一模型调用边界（`packages/core/src/resolver/types.ts:104`）；`ResolveCallRecord`（同文件 :109）已记每次调用的 tokens_in / tokens_out / cost_usd / elapsed_ms / outcome；`packages/pi-extension/src/decision-log.ts` 给了 JSONL 写入与自降级的形状 | 把已有字段落盘并补上请求与回复正文 | 带大小上限的轮转写入器；`createAgentModelPort` 上的调用日志装饰器 |
| 2 接口调用与状态占比 | 工具调用与状态已写进 decision log（`tool_search` / `tool_read` / `tool_resolve` 各带 status）；daemon 的 `jobs.sqlite` 有完整状态机 | 工具侧只需聚合 | daemon HTTP 的逐路由状态计数器与 `GET /v1/stats`（现无任何请求计数） |
| 3 每 agent token | pi 每条 assistant message 带 `usage`，另有 `usage` 条目；vestigio 内部模型的每次调用也有 `ResolveCallRecord`（tokens_in / tokens_out / cost_usd / elapsed_ms / outcome） | 读 `usage` 并累计；把已有的 `calls[]` 落盘 | 无。跨 agent 的均值由审计脚本算 |
| 4 每 agent 耗时 | `turn_start` 带 `timestamp`，`agent_settled` / `agent_end` 是收尾边界；`ResolveCallRecord.elapsed_ms` 已有 | 加计时并写进记录 | 无 |
| 5 注入次数与概率 | `usage_events`（kind `hit`/`access`，channel `hotspot`/`search`/`read`）是持久计数；`injection_receipts` 每个投递 block 一行；`project_activity.activity_seq` 是持久分母 | 概率查询与口径 | 一张 always-on 的逐 turn 行。原因见 2.5 |
| 6 记忆量、临时记忆、池占用率 | `store.countMemories(state?)`、`countMemoriesByProject()`、`readHotspotMemberships(project)`；`eval/memory/audit.mjs` 已按 state/project 报数 | 占用率 = 成员数 / 池容量 | 无 |

仓库已有一份 `docs/development-plan.md`。本文件沿用它的 PR 表与逐条 checkbox 格式，编号独立，不与 PR-01..PR-09 冲突。

## 2. 数据形态

先定形状再写代码。四份产物，各自的保留期与开关不同。

### 2.1 agent 运行摘要（`agent-runs.jsonl`，默认开）

一个 run 等于 pi 的一次 agent 运行：从上一轮 settle 之后的第一个 `turn_start` 到 `agent_settled`，pi 每次 agent 运行发一次 `agent_settled`。同一 session 有多轮输入时产生多条 run 记录，用 `run_id` 区分，按 `session_id` 分组即一次进程使用的合计。

```
{
  "type": "agent_run", "v": 1,
  "run_id": "uuid", "session_id": "...", "session_file": "...",
  "project_id": "...", "project_path": "...", "branch_ref": "...",
  "started_at": "ISO", "ended_at": "ISO", "duration_ms": 0,
  "models": ["provider/model"],
  "turns": 0,
  "outcome": "completed|aborted|error",
  "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
              "total": 0, "cost_usd": null, "complete": true },
  "context": { "start_tokens": null, "end_tokens": null, "context_window": 0 },
  "tools": { "calls": { "memory_search": 0 },
             "status": { "memory_search": { "ok": 0, "not_found": 0 } } },
  "injection": { "delivered_turns": 0, "injected": 0, "matched": 0, "stale": 0,
                 "outcome_counts": { "delivered": 0, "no_match": 0,
                                     "all_deduped": 0, "over_budget": 0,
                                     "timeout": 0, "store_unavailable": 0,
                                     "host_command": 0 } },
  "error": null
}
```

`tokens.complete` 为 false 表示至少一个 assistant message 没带 `usage`，此时 total 是下界。这份摘要是第 3、4 项的权威来源，只含 id、计数、耗时、token，不含正文与输入原文。

### 2.2 内部模型调用日志（`context/model/*.jsonl`，默认关）

第 1 项。主 agent 的会话上下文 pi 自己已经保存，这里只记 vestigio 自己的模型调用，覆盖 resolver（含 judge）、extraction、detector、nav 四个 `AgentName`。取这个边界的原因见第 8 节。

**一个 invocation 一个文件，N 轮都在同一文件里。** 文件名 `context/model/<agent>__<invocation_id>.jsonl`。

```
{"type":"model_invocation_start","v":1,"invocation_id":"...","agent":"resolver",
 "project_id":"...","session_id":"...","input_id":"...","at":"ISO","question":"..."}
{"type":"model_call","v":1,"call_id":"...","invocation_id":"...","round":0,
 "purpose":"judge_expand","layer":"Active","model":"...","at":"ISO","elapsed_ms":0,
 "request":{"messages":[],"max_output_tokens":0,"expect_json":true,"thinking":"low"},
 "response":{"text":"...","finish_reason":"stop",
             "usage":{"tokens_in":0,"tokens_out":0,"cost_usd":null}},
 "outcome":"ok"}
{"type":"model_invocation_end","v":1,"invocation_id":"...","at":"ISO",
 "calls":0,"tokens":{"in":0,"out":0},"cost_usd":null,
 "outcome":"ok|sufficient|insufficient|failed|cancelled"}
```

`round` 是该 invocation 内的调用序号，`purpose` 取 `judge_expand` 或 `medium_summary`，`layer` 是该轮下探的层。一次 resolve 最多 3 次 `judge_expand` 加 1 次 `medium_summary`。

为什么不拆成 3 个文件。已经存在的数据模型就把一次 invocation 表示成 `ResolveOutcome.calls: ResolveCallRecord[]`（`packages/core/src/resolver/types.ts:109`），一个数组装 N 次调用。落盘时拆成 3 个文件会与这个模型相反，回答“第 2 轮有没有推翻第 1 轮”还要跨文件 join。合并成一个文件加 `round` 字段，两种读法都支持，按 round 过滤即可分开看。反向也不贵，每条记录都带 `invocation_id` 与 `round`，真要拆随时能拆。

另一个理由与语义有关。resolver 的各轮之间不累积上下文，每轮是独立的一次 chat 请求，互不构成对话。所以文件表达的是一次决策的轨迹，而不是一段对话。文件头写 invocation，正文写各轮，正是这个形状。

顺带说明，judge 不是一个独立的 `AgentName`。它是 resolver 的 `purpose = "judge_expand"`，与下探共用同一个 agent 身份（`packages/core/src/resolver/judge.ts` 记录了三轮下探共用 judge 调用以守住上限）。所以按 agent 分文件得到 resolver、extraction、detector、nav 四种，judge 在 resolver 文件里。

### 2.3 daemon 接口快照（`iface.jsonl`，默认开）

```
{
  "type": "iface_snapshot", "v": 1, "at": "ISO", "since": "ISO",
  "window_ms": 0, "scope": "daemon",
  "routes": { "GET /v1/health": { "2xx": 0, "4xx": 0, "5xx": 0, "total": 0 } },
  "reasons": { "403_host": 0, "401_token": 0, "400_usage": 0, "500_internal": 0 }
}
```

daemon 与 extension 是两个进程。不往同一个文件追加，各写各的文件，共用同一个轮转写入器。

### 2.4 turn_events 表（migration `0007_turn_events.sql`）

```
turn_events (
  turn_key     TEXT PRIMARY KEY,   -- session_id || '#' || input_id
  project_id   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  branch_ref   TEXT NOT NULL,
  input_id     TEXT NOT NULL,
  at           TEXT NOT NULL,
  outcome      TEXT NOT NULL,      -- delivered|no_match|all_deduped|over_budget|
                                   -- timeout|host_command|store_unavailable|store_error
  reason       TEXT,
  matched      INTEGER NOT NULL,
  delivered    INTEGER NOT NULL,
  estimated_tokens INTEGER,
  block_bytes  INTEGER,
  handler_ms   INTEGER,
  elapsed_ms   INTEGER
)
```

枚举里的 `store_unavailable` 保留但不可达。store 不可用时没有可写的表，该 turn 就不写行（见 2.6），所以它不会出现在任何一行的 `outcome` 里，概率分母也不含这种 turn。

### 2.5 统计口径

- 注入次数：`usage_events` 中 `kind='hit'` 的行数，按 `channel` 分 `hotspot` / `search`。与 `docs/development-plan.md` §12 已定的 hit/access 口径一致，不新造一份。
- 注入概率：`turn_events` 中 `outcome='delivered'` 的行数除以 `outcome<>'host_command'` 的行数。为什么需要这张表：`packages/pi-extension/src/input.ts:71` 对**每一个**非 extension 输入都调 `recordProjectInput`，包括以 `/` 开头的 host command，而 `injection_receipts` 只在真正投递时写行。拿两者相除，分母混进 slash command，概率系统性偏低且无法修正，因为“这一 turn 是 host command”目前只存在于 debug 开关才写的 decision log 里。补一行逐 turn 的持久记录即可给出干净分母，代价是每次真实输入多一次 upsert，与 `recordProjectInput` 现有的一次读加一次写同量级。审计脚本同时输出用 `activity_seq` 作分母的旧口径，差值即 slash command 的稀释量。
- 每 agent token：主 agent 取该 run 内所有 assistant message 的 `usage` 之和加 `usage` 条目（`kind` 如 `cache_warm`）。不取 `getEntries()` 全分支求和，因为续用同一 session 会重复计入上一 run。内部 agent 取该 invocation 的 `model_call` 记录 `usage` 之和，与已有的 `ResolveCallRecord` 同源。
- 平均：审计脚本对 `agent_run` 记录求均值，可再按 `project_id` 与 `models` 分组。
- 临时记忆池占用率：`readHotspotMemberships(project_id).length / pool_capacity`。

### 2.6 开关与保留期

- `agent-runs.jsonl`：默认开。每次 run 收尾一行，磁盘与 CPU 可忽略。
- `context/model/`：默认关，`VESTIGIO_MODEL_LOG=1` 开。含提示词与模型回复。
- `iface.jsonl`：默认只留进程内计数器，daemon 退出与收到 `POST /v1/stop` 时各写一条快照。逐请求落盘需 `VESTIGIO_IFACE_LOG=1`。
- `turn_events`：默认开，仅在 store 可用时写，每 turn 一行。
- 现有 `VESTIGIO_DECISION_LOG` 保持 debug-only，不提升为默认。它继续承担逐 turn 诊断，`turn_events` 承担持久计数。
- 目录默认 `<store>.observability/`，`VESTIGIO_OBS_DIR` 可覆盖。每条流各自上限默认 128 MiB，分片默认 32 MiB，`VESTIGIO_OBS_MAX_BYTES` 可覆盖。超限删最旧的分片，删到低于上限为止，动作幂等。

轮转实现：写入器按分片追加，分片到 32 MiB 换下一个；一个 run 的文件若自身超过分片大小就续写 `<name>.<n>.jsonl`。删除按分片的修改时间从旧到新，删够为止。对外看是若干条逻辑日志，物理上是若干段，避免为 128 MiB 单文件做整文件重写。

上限按写入器各自计算，不按目录总量：写入器只统计自己打开过的分片，超了就只删自己的。目录因此被约束在 128 MiB × 写入器数，本机通常两三个写入器。
这条是被否掉的目录总量口径的替代：目录总量触发、但只删自己的分片时，另一进程留下的残留会让活着的一方删光自己仍然超限，形成饿死。先只删自己的分片、同时按自己的分片总量触发，才同时满足「不碰别人的分片」和「不饿死」。代价是上限不再是整个目录的硬上限。

## 3. PR 表

| PR | 一项交付 | 依赖 | 允许修改的主要路径 |
| --- | --- | --- | --- |
| OBS-01 | 观测日志写入器与记录契约（轮转、上限、删除最旧） | 无 | `packages/core/src/observability/`、`packages/core/test/observability/`、`packages/core/package.json`（仅新增 exports 条目） |
| OBS-02 | agent 运行摘要（第 3、4 项，含工具与注入分布） | OBS-01 | `packages/pi-extension/src/run-log.ts`、`packages/pi-extension/src/daemon-adapter.ts`、`packages/pi-extension/test/` |
| OBS-03 | 逐 turn 行与记忆侧统计查询（第 5、6 项，及第 2 项的工具口径） | 无 | `packages/core/migrations/0007_*.sql`、`packages/core/src/storage/`、`packages/core/src/observability/`、`packages/pi-extension/src/input.ts` |
| OBS-04 | daemon 接口计数与 `GET /v1/stats`（第 2 项的 daemon 口径） | OBS-01 | `packages/daemon/src/service.ts`、`packages/daemon/test/`、`packages/cli/src/` |
| OBS-05 | 内部模型调用日志（第 1 项，resolver/extraction/detector/nav） | OBS-01 | `packages/model-client/src/`、`packages/model-client/test/`、`packages/core/src/observability/`、`packages/daemon/src/memory/`、`packages/cli/src/index.ts`、`packages/pi-extension/src/state.ts`、`packages/pi-extension/src/tools.ts` |
| OBS-06 | 审计脚本与端到端验收（六项汇总） | OBS-01..05 | `eval/observability/`、`scripts/`、`docs/` |

OBS-01 与 OBS-03 互不依赖，都从主线开分支。OBS-02、OBS-04、OBS-05 等 OBS-01，三者之间互不依赖。OBS-06 等前五个。

**合并前审阅**的是 OBS-01（删除不可逆）、OBS-04（新增端点）、OBS-05（写提示词与模型回复正文，数据边界）、OBS-06（报告口径）。OBS-02、OBS-03 是普通实现细节，不逐项等待确认。

## 4. OBS-01 观测日志写入器与记录契约

- [ ] 依赖。无。
- [ ] 文件。仅修改总表中的 OBS-01 路径。
- [ ] 变更。新增 `packages/core/src/observability/` 一个模块，导出轮转 JSONL 写入器与记录类型（`agent_run` / `model_invocation_start` / `model_call` / `model_invocation_end` / `iface_snapshot`）的写前校验。写入器 API `createObsLog({ dir, kind, maxBytes, segmentBytes })` 返回 `{ append(record), openRun(name), close() }`。写入器不 throw，失败计数超阈值后自降级为 no-op 并记一次 `console.error`，与 `decision-log.ts` 同一策略。
- [ ] 可见结果。一个测试进程按小上限写入多条记录，磁盘上出现分片文件，超过上限后最旧分片被删除，日志总量稳定在上限内。
- [ ] 单元验证。`packages/core/test/observability/`：上限触发删除；删除后剩下的分片按时间连续；并发两个写入器实例写同一目录不互相截断；一个远大于上限的外来文件不会被写入器碰，写入器仍按自己的分片总量修剪且不自删到空；非法记录被拒且不写盘；目录不可写时 `append` 不抛。
- [ ] 真实验证。写一个 30 行的一次性脚本，以 `maxBytes = 64 KiB` 写 200 条记录，`ls -l` 打印分片与总大小，断言总大小不超过上限且最新一条可读回。
- [ ] 性能验证。先量对照：现 `decision-log.ts` 追加一次的耗时。再量新写入器追加 1000 条的中位数，要求单条写入中位数不超过对照的 2 倍。两侧写同一长度的记录（`snapshot(i, 128)` 单行 368 字节，对照记录用 `detail` 补齐到同一长度，并有断言守住两者差值在 1% 内）；每轮先后各量一次、交替顺序，判定取每轮比值的最小值，不把不同轮次各自的最小值相除。探针为 `packages/core/test/observability/` 里的计时断言，基线在主干先跑并记下数字。
- [ ] 失败条件。删除逻辑在并发写时删掉正在写的分片；或按目录总量触发却只删自己的分片，使他方残留把本实例饿死到删空。或写入器把异常抛回调用方，使一次观测失败打断正常 turn。
- [ ] 合并前审阅。删除策略属于不可逆写，需使用者确认上限、分片大小与删除口径。已定：每条流各自上限 128 MiB，只删自己的分片，按自己的分片总量触发。

## 5. OBS-02 agent 运行摘要

第 1 项不再需要这一半，但第 3、4 项的主 agent 汇总、第 2 项的工具状态分布、第 5 项的注入 outcome 分布都要在这里落盘，所以本 PR 保留。

- [ ] 依赖。OBS-01。
- [ ] 文件。仅修改总表中的 OBS-02 路径。
- [ ] 变更。新增 `packages/pi-extension/src/run-log.ts`（`AgentRunRecorder`），在 `daemon-adapter.ts` 的 `connectPi` 里注册新的事件钩子 `turn_start`、`turn_end`、`message_end`、`tool_result`（或 `tool_execution_end` 的 `durationMs`）、`agent_settled`、`model_select`。累计 turn 数、逐模型、assistant message 的 `usage`、tool 调用与状态、注入 outcome 分布、起止时间，收尾写 `agent_run`。所有钩子体包在 try/catch，异常只记不改流程。记录只含 id、计数、耗时、token，不含正文与输入原文。
- [ ] 可见结果。跑一次带工具调用与一次注入的会话，退出后 `agent-runs.jsonl` 多一行，用 `jq` 读回的 `turns`、`tools.status`、`tokens.total`、`duration_ms` 与该会话实际相符。
- [ ] 单元验证。`packages/pi-extension/test/run-log.test.ts`：给定一串伪造事件，断言摘要里的 `turns`、`tools.calls`、`tools.status`、`injection.outcome_counts`、`duration_ms`、`tokens.total`；缺 `usage` 的 message 使 `tokens.complete=false`；`agent_settled` 的 aborted 使 `outcome="aborted"`；钩子抛异常不影响写盘。
- [ ] 真实验证。在真实 pi 会话里连续跑三次（含一次带 `/` 命令、一次 aborted），退出后由脚本读回三行，断言行数、`session_id` 关系、`outcome` 分别为 completed / completed / aborted，并把 `tokens.total` 与 pi session 文件里对应 run 的 `usage` 合计逐条对比，差值应为 0。
- [ ] 性能验证。先量对照：不加载 recorder 时一次典型会话的墙钟与 turn 数。再量开启后的同一会话，要求每 turn 额外开销中位数低于 1 ms，整场可见延迟增幅低于 1%。探针为 recorder 内部计时累积，基线在主干先跑。
- [ ] 失败条件。续用同一 session 时 token 被重复计入（用全分支求和就会如此）；或摘要里混进正文与输入原文。
- [ ] 合并前审阅。无（普通实现细节，记录只含 id 与计数）。

## 6. OBS-03 逐 turn 行与记忆侧统计查询

- [ ] 依赖。无。
- [ ] 文件。仅修改总表中的 OBS-03 路径。
- [ ] 变更。新增 `packages/core/migrations/0007_turn_events.sql`（表见 2.4）。在 `packages/core/src/storage/store.ts` 加 `recordTurnEvent(event): void`（`INSERT ... ON CONFLICT(turn_key) DO UPDATE`）与读侧 `countTurnEvents(filter)`、`turnOutcomeCounts(projectId?)`。新增 `packages/core/src/observability/stats.ts`，导出注入次数、注入概率（两个分母都算）、记忆总量与按 state 计数、临时记忆数与池占用率。`packages/pi-extension/src/input.ts` 在现有 try/catch 链里对每条真实输入写一行 `turn_events`，投递与未投递都写，`host_command` 标记 outcome。
- [ ] 可见结果。对一个已有 project，脚本打印记忆总量、各 state 计数、池成员数与占用率、`usage_events` 按 channel 的次数、注入概率的两个分母口径与差值。
- [ ] 单元验证。`packages/core/test/storage/turn-events.test.ts`：同 `turn_key` 重写不增行；`host_command` 行不计入概率分母；概率在两个分母下的数值与手算一致；池占用率在成员数超过容量时的取值与既有不变式一致并断言。
- [ ] 真实验证。对当前 store 跑一次统计脚本，与 `eval/memory/audit.mjs` 的既有输出交叉核对记忆总量与 `usage_events` 计数，两个脚本给出同一个数。
- [ ] 性能验证。先量对照：主干上 `recordProjectInput` 一次调用的耗时。再量加入 `recordTurnEvent` 后一次 turn 写入的耗时，要求增量中位数低于对照的 1 倍。探针为 `packages/core/test/storage/` 的计时断言。
- [ ] 失败条件。写 turn 行失败导致整个 turn 不投递；或迁移在已有 store 上非幂等。
- [ ] 合并前审阅。无（普通实现细节）。

## 7. OBS-04 daemon 接口计数与 `GET /v1/stats`

- [ ] 依赖。OBS-01。
- [ ] 文件。仅修改总表中的 OBS-04 路径。
- [ ] 变更。在 `packages/daemon/src/service.ts` 的单一请求入口后加计数器，按 `method + 路由模板` 与状态类（2xx/4xx/5xx）以及拒绝原因（`403_host`、`401_token`）累加，全部进程内。新增 `GET /v1/stats` 返回当前计数与 `since`。`POST /v1/stop` 与进程退出前各写一条 `iface_snapshot`。`VESTIGIO_IFACE_LOG=1` 时每个请求额外追加一行明细。
- [ ] 可见结果。curl `GET /v1/stats` 看到按路由分组的计数；发一个带错误 Host 的请求后 `403_host` 加一；停 daemon 后 `iface.jsonl` 出现一条快照。
- [ ] 单元验证。`packages/daemon/test/stats.test.ts`：命中各路由后计数正确；401/403 计入各自原因；`/v1/stats` 自身是否计入在测试里固定一种并断言；路由模板把带 id 的路径归并到同一 key（`/v1/jobs/:key`）。
- [ ] 真实验证。启动 daemon，用 `scripts/daemon-smoke.mjs` 的既有请求序列跑一轮，读 `GET /v1/stats` 与退出后的快照，断言两次计数的 total 一致。
- [ ] 性能验证。对照是主干同一请求序列的 p95。要求加计数器后 p95 增幅低于 5%。探针是对 daemon 发一串 keep-alive 请求、按请求计时的 p95（`scripts/daemon-smoke.mjs` 只断言行为，不含计时，不能当探针），基线在主干先跑。
- [ ] 失败条件。计数器在并发请求下丢更新或错计；`/v1/stats` 泄露 token 或 store 路径。
- [ ] 合并前审阅。无新交互，但新增了一个端点，接口边界由使用者确认。

## 8. OBS-05 内部模型调用日志

- [ ] 依赖。OBS-01。
- [ ] 文件。仅修改总表中的 OBS-05 路径。
- [ ] 变更。在 `packages/model-client/src/agents.ts:40` 的 `createAgentModelPort` 上开一个可选的 `onCall` 观察点并加一层装饰器，记录 `ModelRequest`（`packages/core/src/resolver/types.ts:40`）与 `ModelResult`。三处构造点（`packages/daemon/src/memory/runtime.ts:78`、`packages/cli/src/index.ts:861`、`packages/pi-extension/src/state.ts:272`）各传入写入器，默认不传即行为不变。按 2.2 逐调用追加一行 `model_call`，invocation 起止各一行。resolver 的 invocation_id 由该次 resolve 的 request 派生；extraction / detector / nav 各用其 job key。回复正文只在 `VESTIGIO_MODEL_LOG=1` 时写。
- [ ] 可见结果。开开关后跑一次 `memory_resolve`，`context/model/resolver__<id>.jsonl` 里出现一到四条 `model_call`，`round` 为 0..n，`purpose` 与 `layer` 与该次下探一致，`tokens_in`/`tokens_out` 与工具返回里的 `model calls` 行相符。
- [ ] 单元验证。`packages/model-client/test/call-log.test.ts`：包一层假 port，断言每次 `complete` 产生一条记录且字段完整；失败结果记 `outcome="failed"` 且仍带 `reason`；`onCall` 抛异常时 `complete` 仍返回原结果；未传 `onCall` 时零开销路径不产生记录。`packages/pi-extension/test/tools.test.ts`：开关打开时一次 `memory_resolve` 产生一个 `resolver__resolve-<16hex>.jsonl`，起止记录与 `model_call` 轮数自洽；开关关闭时模型仍被调用一次但不产生文件；没有模型调用时也不产生文件。
- [ ] 真实验证。对一次真实 resolve，把日志里的 `tokens_in`/`tokens_out` 与 `ResolveOutcome.calls[]` 的对应值逐条比较，差值应为 0；再对一次 extraction 与一次 detector 各跑一遍，确认三个 agent 的 invocation 各自成文件。扩展内那次 resolve 另用真实工具与真实写入器对一次假 model port 再验一遍，确认扩展路径也落文件。
- [ ] 性能验证。探针为 `packages/model-client/test/` 里对假 port 的计时断言（量装饰层本身），基线在主干用同一探针先跑。要求非模型开销的绝对增量中位数低于 0.1 ms，且单次调用写入耗时中位数低于 0.5 ms。真实模型下的相对增幅由 OBS-06 的脚本给出，不在本 PR 判定。
- [ ] 失败条件。日志写入阻塞模型调用或改变超时；日志里的 token 与 `ResolveCallRecord` 不一致；未开开关时仍有文件产生。
- [ ] 合并前审阅。日志含提示词与记忆候选正文，属外部模型数据边界，需使用者确认默认关闭与保留期。

## 9. OBS-06 审计脚本与端到端验收

- [ ] 依赖。OBS-01、OBS-02、OBS-03、OBS-04、OBS-05。
- [ ] 文件。仅修改总表中的 OBS-06 路径。
- [ ] 变更。新增 `eval/observability/audit.mjs`，只读，输出六项：agent 运行条数与最近汇总、接口计数与状态占比、每 agent token 总/均值（主 agent 与内部 agent 分开）、每 agent 耗时总/均值、注入次数与概率（两个分母）、记忆总量与临时记忆与池占用率。支持 `--json`、`--since`、`--project`、`--limit`、`--agent`。不接仪表盘，不做写回。`docs/operating.md` 增一节说明如何读这些数。
- [ ] 可见结果。一条命令打印六项统计；`--json` 输出机器可读；对空 store 与空观测目录不报错，明确输出 0 与“无数据”。
- [ ] 单元验证。脚本层测试：构造固定 JSONL 与固定 store 夹具，断言六项字段的数值；损坏的 JSONL 行被跳过且计数进日志。
- [ ] 真实验证。在一个真实会话跑完后执行脚本，人工核对 `duration_ms`、token 合计、注入概率与同场 decision log（开启时）一致。
- [ ] 性能验证。对 10 万行观测日志执行脚本，要求墙钟低于 5 秒。探针为脚本自身计时，基线在生成夹具时先量。
- [ ] 失败条件。脚本写任何东西到 store 或观测目录；或在缺列、缺文件的旧数据上抛异常而非降级。
- [ ] 合并前审阅。报告口径由使用者确认，特别是第 5、6 项的中文名称与定义。

## 10. 本计划不证明的部分

- 不做仪表盘，不做实时视图，不做告警。
- 不采集 LLM provider API 的调用与状态，那属 pi 自己的 telemetry。
- `agent_run` 的 token 值在 assistant message 缺 `usage` 时只是下界，本计划不补估算器。
- 主 agent 的会话上下文不在这里保存，仍以 pi 自己的 session 文件为准，本计划不解析它。
- 轮转的删除不可逆，本计划不提供恢复已删分片的手段。
