# 记忆召回质量评估：现状审计与实施建议

审计基准为 `ccd8f5a`。本文是 Memory Evaluation System 提案的 Phase 1 交付，供评审。现有路线图已将 PR-08 分配给使用统计与归档维护。建议将下文的离线评估作为独立变更，作为 PR-09 实测的输入。评估变更的编号可随路线图确定。[现有路线图](development-plan.md#12-pr-08-使用统计与归档维护)

## 1. 现有能力与埋点缺口

| 环节 | 可直接复用 | 当前证据的边界 |
| --- | --- | --- |
| 用户输入与工具触发 | Pi 扩展的 `input`、`before_agent_start`、`agent_end` 和 session tree 生命周期。`SessionState.nextInputId()` 为普通输入分配 ID，`memory_search` 和 `memory_resolve` 的工具路径已有 `tool:<toolCallId>`。 [`extension.ts`](../packages/pi-extension/src/extension.ts#L61) · [`state.ts`](../packages/pi-extension/src/state.ts#L208) · [`tools.ts`](../packages/pi-extension/src/tools.ts#L98) | 输入没有与工具共用的逻辑 turn ID。现有日志无法可靠识别无工具调用的已结束 turn，也无法仅凭 session ID 区分队列、steer、分支和重试。 |
| Hotspot 与注入 | `planInjection` 提供 `matched` 和 `injected`。`commitInjection` 使用投递回执及 ledger。`DecisionLog` 提供输入 ID、数量、原因、耗时和估算 Token。现有 Pi harness 可从 provider request 验证模型实际收到的文本。 [`inject.ts`](../packages/core/src/hotspots/inject.ts#L99) · [`input.ts`](../packages/pi-extension/src/input.ts#L115) · [`decision-log.ts`](../packages/pi-extension/src/decision-log.ts#L13) · [Pi harness](../eval/pi/README.md) | 线上日志只记候选和注入数量。规划、回执和模型请求是三种独立观测。持续对照故障样本时，应保留排序后的匹配 ID、筛选结果和投递状态。 |
| Active / Archived / Obelisk | `layeredSearch` 已返回 `LayerOutcome`、最终 cards 和 history excerpts，可直接为可见候选评分。`HistoryPort` 支持探测、受限搜索和按锚点读原始证据。 [`layered.ts`](../packages/core/src/retrieval/layered.ts#L442) · [`types.ts`](../packages/core/src/retrieval/types.ts#L76) · [Obelisk adapter](../packages/source-obelisk/src/history-port.ts#L55) | 分层计数可复用到成本和排查报告。最终 cards 经过上限、去重、裁剪等处理，无法反推每次 gather 的原始排序。Obelisk 不可用、锚点无法验证、没有搜到是三个状态。 |
| Resolver | `ResolveOutcome` 暴露分层结果、候选、history、模型调用、耗时、Token、成本和最终决策。工具 `details` 还提供冲突、缺失、预算和持久化状态。已有真实 Resolver harness 覆盖 Active、Archived、history、冲突与取消。 [`resolver/types.ts`](../packages/core/src/resolver/types.ts#L92) · [`resolver.ts`](../packages/core/src/resolver/resolver.ts#L597) · [`tools.ts`](../packages/pi-extension/src/tools.ts#L250) · [Resolver harness](../eval/resolver/README.md) | `gatherLayer` 会把每次结果并入 bundle。最终产物不足以还原每次 gather、同层 retry、送审证据及终止节点。只看最终状态无法可靠判断 Resolution Miss 和 Rescue。 |
| 使用、过期与 Repair | 搜索/读取使用事件、Hotspot 回执和 freshness 事件可提供检索交付或生命周期证据。已有真实模型 harness 覆盖过期标记、修复保真与答案冲突，request harness 可观察 Agent 自由选择。 [`tools.ts`](../packages/pi-extension/src/tools.ts#L104) · [`store.ts`](../packages/core/src/storage/store.ts#L618) · [Live eval](live-eval.md) · [Request harness](../eval/requests/README.md) | 使用事件表明读过或返回过，答复是否正确采用需要独立核对。当前 freshness 状态也无法说明回答当时是否误用了旧事实。Repair 是可能改变后续快照的维护活动，应记录其起止和因果位置。 |
| 回放与样本 | 现有 `eval/pi`、`eval/resolver`、`eval/live`、`eval/requests` 分别提供协议、分层、真实模型和自由选择场景。`eval/baseline` 提供单题对照脚本。`memory-eval-cases.jsonl` 有 13 条输入与 `expected` / `why` 的场景说明。 [Baseline](../eval/baseline/README.md) · [现有 fixture](../eval/fixtures/memory-eval-cases.jsonl) | 现有样本可作为种子。跨 commit 的共同评估还需要版本化评分契约、人工确认的事实和可用证据、固定快照、样本级配对以及覆盖率报告。 |

## 2. Trace 的责任边界

**Pi Extension 建立 turn 边界，Core 补少量调用内观测，评估器负责评分。** 第一版离线 runner 先消费现有结构化结果和 harness 证据。需要分层诊断时，可为 `layeredSearch` / `resolveMemory` 增加可选的结构化 observer，记录 gather 序号、层、阶段状态、排序证据引用、交给 judge 的证据引用、标准化决策及停止原因。复用现有 `LayerOutcome`、`ResolveCallRecord`、`SourceRef` 和 `(memory_uri, revision)`。综合 trace、标签、数据保留与成本策略由 host 或评估器管理。[分层契约](../packages/core/src/retrieval/types.ts#L96) · [Resolver gather](../packages/core/src/resolver/resolver.ts#L798) · [共享契约](../packages/core/src/contracts/types.ts#L25)

- 在输入被实际提交到活跃分支时绑定逻辑 `trace_id`，带上项目、session、分支与用户 entry 锚点。Hotspot 的输入预处理先保留 `input_id`，待已提交的 entry 出现后关联。工具用 `tool_call_id` 标记 invocation，同一 invocation 按 attempt 继续追踪。使用实际所属 entry 关联 queued 和 steer 输入。模型响应完成时封账，取消、分支切换、截断或 hook 缺失时记录 `partial` 或 `unknown`。具体关联应先用真实 Pi harness 验证普通输入、队列、steer、续会话、fork 和 compaction。
- 每个被抽中的合格 turn 都写一条终态，即使工具计数为零。已完成且观察完整的 turn 支持判定未调用工具。记录显式检索意图与工具执行结果，失败的调用仍算触发。Hotspot 自动交付单列。离线回放可用历史 session 重建有证据的 turn，缺少边界的样本保留未知。
- 事件最小字段为 `schema_version`、`trace_id`、`event_seq`、`stage`、`status`、`scope_ref`、`occurred_at`。各阶段按需附上 attempt、排序引用、耗时和成本。区分 candidate、提交给 Resolver 的证据、Hotspot 交付、工具返回和可验证的模型可见证据。工具 `details` 可为诊断提供依据，模型可见性由工具 `content` 或受控 harness 的实际请求验证。
- 线上仅持久化项目内的不透明引用、计数、时序和受控原因码。按需对规范化查询使用本地带密钥摘要。自由文本、证据正文、生成查询和最终回答保留在原始 session 或授权的隔离运行资料中。日志访问、保留期和队列容量由配置约束。Ground Truth、规则产物、人工复核和模型推断使用独立来源字段及版本。

## 3. Ground Truth 与可重复回放

### 样本契约

| 内容 | 建议字段 |
| --- | --- |
| 身份与时间 | `sample_id`、`project_ref`、`session_ref`、`turn_ref`、`as_of`、`snapshot_id`、`category`、`difficulty` |
| 查询环境 | `user_query`、`context_ref`、`should_recall`，以及 `context_sufficient`。两项标签均允许 `unknown`，以便过滤不可判定输入。 |
| 历史证据 | `source_state`（`present` / `absent_verified` / `unknown`），`expected_source_refs`，按事实保存证据来源及有效时间。 |
| 可用记忆 | `store_state`（`usable` / `absent_verified` / `stale_only` / `conflicted` / `unknown`），按事实保存可接受的 `(memory_uri, revision)` 与限定条件。 |
| 答案和行为 | `expected_answer_facts`、禁止作为当前事实的旧结论、预期操作或文件状态（适用时）。允许一个事实有多个可替代证据，组合题另记全部必要事实。 |
| 标注来源 | 样本和指南版本、标注者、复核状态、注释、脱敏策略。人工确认后进入固定评分集。 |

从已获授权的真实 Coding Agent session 按项目、输入形式和依赖类型分层抽样。将显式回忆、隐式约定、技术配置、用户偏好、历史排障、时间冲突、负例、缺失、歧义、多证据和跨项目同名场景纳入样本。先用现有 fixture 和可验证的 harness 场景校准标注规范，再扩到提案建议的 100–200 条。按项目或 session 分开校准和留出数据，保留每层样本数，生产频率通过线上抽样单独估计。

标注时先冻结模型作答前可见的上下文，再核验 Obelisk 锚点和记忆快照。覆盖标注用独立的快照审阅及已知证据映射，例如检查 head、revision、作用域、生命周期和导航可检索性。正式 runner 的查询结果只用于测量召回。正例金标准优先来源于可定位的原始历史和当时状态，负例需给出上下文自足或缺失核验依据。第二位评估者抽查，并复核过期冲突、缺失和分歧样本。`stale_only`、`conflicted` 和 `unknown` 各自保留，避免给不可核查的样本贴缺失标签。

评分分三个独立职责。Retrieval Evaluator 按证据 ID、revision 和标注计算命中。Coverage Evaluator 按快照及已证实的原始历史判断覆盖。Usage Evaluator 先用可核验的事实或任务状态判分，语义歧义才升级给单独的 judge。使用不同模型家族，隐藏 baseline/candidate 身份，固定评分规则、提示词和模型版本。要求输出证据引用、`correct` / `partial` / `unused` / `incorrect` / `unknown` 及原因，以人工复核的校准集监测一致性。相同 token 或措辞仅为线索。需要衡量因果增益时，可在受控样本上做有记忆/无记忆配对实验，报告配对差异与模型波动。[现有 repair judge](../eval/live/README.md#what-it-measures-milestone-2-f5-repair)

### 快照与运行隔离

复用现有 harness 的隔离 store 和 Obelisk home。每个固定样本绑定同一份查询前快照、时钟、项目作用域和当时可见的原始历史，或使用可重建且有清单校验的种子。SQLite 在一致性边界做备份，或从规范种子创建。给 baseline、candidate 和重复运行各自的 scratch 副本，并固定 Hotspot 的输入路径、初始 ledger、导航状态、来源语料与依赖版本。Obelisk 索引用隔离语料重建或从配套索引快照复制，原始历史裁切在 `as_of`。时钟无法锁定的步骤在 manifest 中声明。

生产 store 的 revision 序列只提供部分历史。`setMemoryState` 会就地更新 head revision 的状态和 FTS 成员关系。导航、Hotspot ledger、stale 事件与会话分支也需要对应时间点的证据。历史快照缺失时，标为 `current_snapshot` 或 `approximate`，单独报告。`ResolveInput` 已提供 `wall_now` 与 `mono_now` 时钟入口。Resolver 发现并使用原始历史时可持久化总结，所以须通过隔离副本运行，命中和覆盖按运行前快照评分。 [状态更新](../packages/core/src/storage/store.ts#L395) · [Resolver 时钟](../packages/core/src/resolver/types.ts#L208) · [Resolver 持久化](../packages/core/src/resolver/resolver.ts#L896)

### 混淆矩阵

上面两个指标回答的是「有没有做到」，混淆矩阵回答的是「分母是谁」。离线 harness 只把样本分成两类，因为数据集本身只有这两类标注：**应该交付**（`expected_memory_ids` 或 `expected_source_refs` 非空，或要求交付 stale 标记）与**应该安静**（没有期望，但写了 `forbidden_memory_ids` 或 `expected_status`）。只写 `forbidden_memory_ids` 的空期望样本不算「未被测试」：它带着可被违反的约束。真正的空样本（既无期望也无禁止项、无期望状态）单独报告为 `unlabelled`，不计入任一侧，否则「没标注」会被当成「通过」。

当前 95 条基线（`node --import ../pi/hook.mjs ./run.mjs`，读 `out/report.json` 的 `confusion`）：

| | delivered / quiet | missed | leaked |
| --- | --- | --- | --- |
| 应该交付（56） | 49 | 7 | 0 |
| 应该安静（39） | 38 | 0（期望状态未达成） | 1 |

由它得到两个指标：`expectation_hit_rate` = 49/56 = 0.875，回答「该给的东西给了几次」；`quiet_rate` = 38/39 = 0.974，回答「不该出声的时候有多安静」。`unlabelled` 为 0。7 条 missed 是已经记录在案的缺口（两条 archived 措辞问句、三条多记忆组合、两条多主题检索行），不是新增失败；唯一一条 leaked 是 `inject-neg-docker-image`（「容器里怎么装 nginx」→ `mem-docker-image`），原因是查询首词的整词别名规则同时在支撑「迁移失败后先做什么」。

混淆矩阵与 `false_positive_rate` 的口径差异必须保留：后者以全部可评分样本为分母（1/95 = 0.011），前者以「应该安静」的 39 条为分母（1/39），同一个泄漏在两个数字里被稀释程度不同，引用时必须说明用了哪一个。

## 4. 指标与归因

每项输出分子、分母、未知数、观测阶段、样本类别及版本。分母为零时报告 `null`。检索实验以固定查询在固定快照上运行，Agent 端到端实验以用户 turn 为单位，两种结果各自保留。

| 指标 | 评分口径 |
| --- | --- |
| Should-Recall Rate | 人工标注 `should_recall=true` 且触发可判定的 turn 中，发起显式 memory 检索的比例。同时记录负例上的触发率、Hotspot 自动交付，以及正确且已证实依赖当前上下文的无查询结果。无查询且可观测到正确 Hotspot 使用时，显式触发率和有效命中分别更新。 |
| Recall@1/3/5/10 | 按提案的至少一条命中语义计算。分母为固定检索查询中事前存在可用记忆且标签可判定的样本。分别标明可见候选排名和 gather 排名。未查询样本反映在触发率和端到端有效命中率。多记忆题另报必要事实覆盖率。Obelisk 命中以 SourceRef 独立评分。 |
| Candidate / Injection FP | 分别按可判定的候选项数、实际可见的交付项数作为分母，按 `stage + attempt + evidence identity` 计数，并在报告标明跨 attempt 的重复规则。相关但过期的证据单列；未知相关性的项另记。 |
| Memory Coverage | 原始历史证据已确认可用的样本中，快照覆盖必要事实的比例。输出 `source_state × store_state` 的计数，区分无覆盖、仅过期、冲突和未知。 |
| Effective Hit Rate | 存在可用仓库记忆的样本中，Agent 正确采用相关证据并受益的比例。已观测且未触发、未交付或未使用均计入对应失败。只有答案正确而无法确认依据时标记用法未知，并单列分母的可评率。仅靠原始历史恢复的使用效果独立报告。 |
| Stale Misuse Rate | 可观测到过期证据已送达且回答可判定的 turn 中，将过期事实当作当前事实的比例。另报全部已判定 turn 中的发生率。明确历史时间或以旧值做对照可判为正确使用。 |
| Rescue Rate | 只在首轮检索没有所需证据并经固定快照验证后续路径有可恢复证据时进入分母。按 Archived、Obelisk、Resolver 同层 retry 报机会数、首次恢复路径及是否实际交付。无充分事前证据时标为可恢复性未知。 |
| Retrieval Cost | 计量同一 cohort 内 Hotspot、检索、Resolver 和交付，输出可观测的 P50/P95、模型调用数、输入/输出 Token、估算注入 Token 和 USD。底层 SQL 操作量需明确计数单位，缺失时保留 `null`。同一 cohort 的总检索成本除以有效召回次数，按 Token 和 USD 分开，报告价格表及用量覆盖率。后台 Repair、Agent 本身开销和评估 judge 开销单列。耗时以用户墙钟和阶段时钟分别汇总。 |

- **Trigger Miss** 要求人工标签应该显式检索、完整观测为零次、且当前上下文或自动交付没有满足需求。已通过当前上下文完成的样本用 `context_satisfied` 描述结果，并保留原始触发数据。
- **Retrieval Miss** 要求已执行检索且快照存在作用域内可用证据。若 gather 命中但出现在可见上限之后，标上排序或裁剪原因。完全不可观测的 gather 可按最终可见候选判分，并保留原因未知。
- **Resolution Miss** 要求 Resolver 已看到足够覆盖必要事实的证据，仍然错误拒绝、选用冲突证据或漏交付。证据在 gather 候选中但从未送审时，附上预算或证据选择标签。
- **Usage Miss** 要求 Agent 已收到足够证据但最终行为未正确使用。过期误用、无关注入、冲突可同时打标签。结果记录置信度、证据引用和 `unknown` 原因。
- **Memory Gap** 表示已核验仓库中缺少可用证据，细分缺失、仅过期和冲突。**Source Gap** 沿用提案术语，表示该缺口已在原始历史中找到证据，是 Memory Gap 的子类。原始历史经过核验仍缺失时报告 `source_absent_verified`，来源不可用或未核验时报告 `source_unknown`。

## 5. Shadow 观测与预算

先用离线回放验证评分与 trace 再启用 Shadow。在线默认关闭，按项目启用。按 turn ID 在输入时做稳定抽样，并保留抽样率与分层信息。可完成的观测只向有界队列发送标识、阶段结果和引用。独立本地 worker 在 turn 结束后取任务，按需从授权的 session 读取证据，将本地 SQLite 作为单写者事件库。生产 hook 不等待 worker、SQLite、模型调用或重试。worker 失败、背压、超时或引用失效时累计丢弃与未知数，生产链路照常完成。事件按 `(trace_id, event_seq)` 幂等写入，work item 设租约、有限重试和到期回收。评估器的访问权限限于读取证据和写评估库。

按阶段逐步付费。先用规则对结构化 trace、已审标签和能核验的事实评分。对使用和过期语义仍不明的样本才调用独立 judge。配置单日调用、Token 和 USD 上限，限制并发、证据窗口及单条超时，耗尽后记录 `budget_skipped`。复用条件包括输入、证据、回答和评分器版本，成本报表同时给出跳过数、成功数和单位已判样本成本。真实样本外发遵守项目授权，无法发送时使用本地机械评分或人工复核。

**已落地的第一层（只观测，不参与回答）**：`packages/pi-extension/src/decision-log.ts` 的 decision log 本来就在生产里按需开启（`VESTIGIO_DECISION_LOG`，默认关闭、写失败不抛）。这一轮给它补了能串起一次 turn 的字段——`memory_ids`（实际交付的记忆）、`matched_ids`（预算与去重前的候选）、`query_hash`（sha256 前 12 位）与 `query_chars`，仍然只有标识、计数和耗时，没有正文、没有原始问句。读取侧是 `eval/memory/shadow.mjs`：它按 session 与 `input_id` 把 input / tool_search / tool_resolve / tool_read 记录拼成一条 trace，输出不需要标签就能算的比率（交付后是否调用工具、是否读了正文、没有交付时是否会主动检索、gather 零命中率、resolver 状态分布、被注入最多的记忆、input handler 时延），并用 `--sample` / `--max-turns` 做确定性抽样与容量限制。抽样与评估都在日志之后发生，生产 hook 不等待、不知道、也无法被它拖慢，因此它满足第 12 节第 10、11 项；代价是它不能计算 Recall——那仍然需要标签，见 `eval/memory/trace.mjs` 与 `run.mjs`。

## 6. 交付顺序与回归门槛

1. **离线评估首批交付。** 设立版本化 schema 和标注规范，从现有 fixture 中选可确认的正负场景与旧值冲突样本做小型校准集。复用现有 harness 增加一个报告入口，先产出可见候选 Recall@K、可测的 Candidate / Injection FP、核验快照上的 Coverage 和已有成本字段。缺乏答案证据的样本保留 Stale Misuse 和 Effective Hit Rate 未知。使用固定数据、快照及配置跑出首份基线，再按分层计划扩展到 100–200 条人工复核样本。首版已交付并扩展到 95 条样本（补入历史层、同名冲突、过期标记、历史补位场景，候选批第 3 批里 35 条可确证的隐式召回与近义否定样本，手写的一批检索面覆盖、跨项目、多主题组合与近义否定样本，以及从候选批人工复核后并入的 16 条检索面近义否定样本），见第 7 节的实测结果。
2. **补齐行为归因。** 用 Pi harness 验证 turn 关联和无工具终态，再补最小 Core observer。构建 Trigger/Retrieval/Resolution/Usage 各一条能稳定区分的 fixture，另外覆盖只靠当前上下文答对、来源存在但仓库缺失、正确候选被裁剪、多证据题和 rescue。交付阶段级 trace、样本级诊断和空分母/未知处理测试。
3. **接入独立 Shadow 和配对回归。** 先验证禁用、队列满、worker 崩溃、预算耗尽和引用已删时的行为，再开放授权项目抽样。配对报告按 `sample_id + snapshot_id + arm` 核对同一组可比较样本，记录 Git commit、项目版本、数据与快照版本、评估器及 schema 版本、模型和提示词版本、随机参数、策略参数、运行时间及各类实际执行、失败和跳过数。对关键模型样本重复运行，报告每次结果及配对差异，并跟踪同一 session 的样本相关性。
4. **先门禁确定性契约。** CI 可门禁 fixture 的项目隔离、负例注入、明确的过期冲突、已知匹配的结果顺序、trace 完整性与断队列时的生产行为。总体 Recall、Effective Hit、Stale Misuse、Rescue、P95 与单位成本先以同口径基线和配对报告观测。分母、标签和波动稳定之后，再为重复可测的样本定义回归容差。真实模型使用的质量分数先用于人工评审，确定性产物缺失和错误码仍可做硬门禁。

## 7. 本次验证及验收边界

`pnpm install --frozen-lockfile` 和 `pnpm -r typecheck` 通过。使用 Pi `1.5.2` 与 loopback mock provider，`eval/pi` 的 `--only new_session` 通过 13/13 项检查，随后全量 harness 通过 110/110 项检查。断言覆盖实际请求中的首次注入、尾部位置、跨项目排除、重复去重、续会话、compaction、queued、steer、stale、request 和进程退出。两次运行前后的真实 Obelisk 索引 mtime 一致。证据位于 `/tmp/vestigio-proof-memory-eval.qmJmfZ/run.log` 与 `/tmp/vestigio-proof-memory-eval-full.FvRTg5/run.log`，各目录保存了 `exit-code`。

离线评估已落地在 `eval/memory/`，由 `run.mjs`（95 条标注样本，固定 20 条记忆 / 2 个项目目录，临时 SQLite store）和 `compare.mjs`（按 `case_id` 配对，回归时退出码 1）组成，复用 `eval/pi/hook.mjs`，不调用模型、不联网。三种观测面：`inject` 走 `recordProjectInput` + `planInjection`，`search` 走 `layeredSearch`（项目作用域，`limit: 10`），`search` 加 `include_history` 时由脚本化 `HistoryPort` 提供 Obelisk 形状的命中。首份基线见 `eval/memory/baseline.json`：95 例中 49 hit / 38 clean / 7 miss / 1 误注入 / 0 error，Recall@1/3/5 均为 0.925，`inject_hit_rate` 0.906，`false_positive_rate` 0.013，`source_gap_rescue_rate` 1.000。7 条 miss 都是有记录的已知缺口而不是噪声：两条「整句问旧版配置」的样本触不到 `mem-archived`（注入面按设计不出现归档记忆，检索面则因重叠二元组规则匹配不到），三条组合样本（如「连接池 超时」这种把两个主题写进一句话的检索）需要两条记忆同时命中，以及两条把两个主题写进一次检索的样本（「迁移 端口」「缓存 超时」）——合取匹配器要求同一条记忆同时具备所有词元，所以跨主题检索本就需要一次一个主题地搜，暴露的是 gather 策略而不是标注问题。唯一一条 `false_positive` 是手写的近义否定样本 `容器里怎么装 nginx`：`容器` 是 `mem-docker-image` 的整词关键词且位于句首，按第三条判据（整条输入以该词开头）允许单独成立，于是被注入——这与「迁移失败后先做什么」能命中出自同一条规则，规则无法区分「容器」是主题还是任务里顺带提到的词。其中一条记忆带待处理的过期事件，`inject-stale-flagged` 断言它出现时确实被标记为 stale（`expected_stale_ids`），也就是「过期信息到达 Agent 时携带警示」这一环已经可测；至于 Agent 是否据此修正判断，仍需真实回合。`candidate_false_positive_rate` 与 `injection_false_positive_rate` 分开统计（都是 0.042，即 24 条带禁止项的注入样本里 1 条在候选阶段就已混入），`budget_rescued` 为 0，说明 3 条预算上限在这批样本上没有参与救场；注入样本同时记录 `InjectionPlan.reason`（`no_match`、`over_budget`、`all_deduped` 等），让「没有注入」附带原因而不再只是一个空结果，这正是第 10 节诊断矩阵所需的字段；`inject-negative-unrelated` 还额外断言 `expected_status: not_injected`，确认流水线是明确判定不注入。这也补齐了 §12 第 4 项「能区分 Candidate False Positive 和 Injection False Positive」。两次运行除 `generated_at` 外报告字节一致；单例耗时不再写入报告，因为这个 harness 不做模型调用与索引工作，计时只会在基线里制造噪声。

该工具对生产代码的敏感性做过四次红绿验证。其一，把 `packages/core/src/hotspots/match.ts:38` 的 `DEFAULT_MIN_MATCH_SCORE` 从 1 临时改为 99，4 条注入样本转为 miss，`compare.mjs` 报告 `regressions: 4` 并退出 1。其二，让 `packages/core/src/retrieval/conflict.ts` 的 `findConflictingMemoryIds` 返回空，`search-conflict-port-rule` 从 hit 变为 miss（`expected_status: conflicted` 不再满足），退出 1。其三，绕过 `packages/core/src/retrieval/layered.ts` 里 `entry.source_ref.project_id !== projectPath` 的丢弃分支，`history-foreign-dropped` 从 clean 变为 false_positive，退出 1。其四，让 `packages/core/src/hotspots/pool.ts` 的 `freshnessFor` 忽略 `store.readFreshness` 的返回值，`inject-stale-flagged` 从 hit 变为 miss，退出 1。四次均改回后重新全绿，`git diff` 为空。

该工具也能回答具体的调参问题。把同一个 `DEFAULT_MIN_MATCH_SCORE` 依次设为 1（当前生产值）、2、3、4，在同一份基线上各跑一次：强信号规则落地后重新扫一遍：阈值为 1（生产值）时 `inject_hit_rate` 1.000、`false_positive_rate` 0.000；阈值为 2 时 `inject_hit_rate` 降到 0.800、Recall@1 降到 0.889；阈值为 3 时 0.600 / 0.778；阈值为 4 时 0.400 / 0.667。精度已被强信号规则处理掉，抬阈值现在只剩召回损失。也就是说在这批判定样本上精度与召回是直接对冲的，当时的 18 条样本不足以定阈值，生产值保持 1 未改，这条对比是可扩展数据集后的候选实验而不是修复。

首版暴露三个待处理项。其一，`memory_search` 的默认检索是析取词元加合取匹配（`buildMatchQuery` 用 `AND` 连接一元组与二元组），自然语言问句通常一条也匹配不到，因此样本使用关键词式短语；这与工具契约一致（`packages/pi-extension/src/tools.ts` 写明 exact words work best，自然语言走 `memory_resolve`），但意味着 Recall 数字只在关键词查询口径下成立。其二，`旧配置的字段名` 曾因共享二元组「配置」注入 `mem-deploy-port`，`部署脚本默认端口` 曾因共享「端口」（只是别名「端口约定」的一个片段）额外注入两条同名端口约定；两处都已修复：`matchHotspots` 现在要求至少一个「整词别名」、「连续别名短语」或「两个独立词元」才算强信号，单独一个共享词不再足够。修复后这两条样本转为 clean，召回未损失（11 hit / 7 clean / 0 FP）。规则后来收敛成三条判据，都由 `packages/core/test/hotspots/match.test.ts` 从正反两面钉住：一是整词别名、连续别名短语或两个独立词元之一；二是重叠二元组只算一次证据（「的默」与「默认」是同一个词）；三是单词别名单独成立需要整条输入就是那个词（不超过 3 个词元）或以它开头——中文问句先立主题，所以「迁移失败后先做什么」算命中，而「把部署章节的截图换成新版」只共享「部署」就不算。第三条来自候选批第 2 批（119 条草稿）：收紧后该批误注入从 9 条降到 6 条，当时的 18 条基线召回未变。其三，`memory_resolve` 并不绕开同一个匹配器：它搜的是同一份索引，靠裁判模型给出的 `next_queries` 把问题改写成匹配器能用的短语。`eval/memory/rescue.mjs` 单独量了这一环：在候选批第 2 批的 84 条带期望标签的样本上，字面查询只命中 32 条，改写后补回 42 条，仍有 10 条缺失；52 次字面失配里 50 条可在 gather 阶段救回，代价 $0.0103 / 52 次调用。这说明召回短板不在匹配器本身，而在「模型能否给出与记忆共享整词的短语」；该脚本只重放改写这一步，不跑裁判、下降与历史层，因此它是该环节的代理指标。其四，第 12 节第 1 项（Agent 是否在需要历史时触发查询）已由 `eval/memory/trigger.mjs` 用真实模型量出：12 个场景各跑 2 次共 24 回合，should-recall 0.938，active 0.813，over-trigger 0.125，单次成本 $0.028，p50 14.5 s。关键在分层：4 个「热」场景（热点层已注入块）全部只是读取注入块，4 个「冷」场景（`planInjection` 判为 `no_match`、只能靠主动检索）全部主动发起 `memory_search`/`memory_resolve`，因此主动检索率正好是冷场景那 8 个回合。也就是说「该查时去查」和「已有指针时不再重复搜」这两件事都成立；只有热场景时这个数字会读成 0.250，容易得出相反结论。注意 `should-recall` 只统计最终答出事实的回合，因此它同时包含「没查」和「查了没用上」两种失败，后者由 `usage_miss` 单独列出。为了让这几种失败各自可定位，harness 还会记录「模型有没有真的拿到过记忆」：注入块以 user 消息到达，工具结果以独立消息到达，因此扫描所有非 assistant 消息里是否出现过 `memory://` 就能判定交付，进而把每个回合归到 `trigger_miss`（没调工具）、`retrieval_miss`（调了但什么都没交付）、`usage_miss`（交付了却没用上）三类之一，报告里以 `failures: trigger N retrieval N usage N` 输出；这也补齐了 §12 第 2 项对四种失败的区分（Resolution Miss 需要裁判层单独观测，仍待补）。
其七，`memory_resolve` 在候选集为空时并不会跳过裁判：`packages/core/src/resolver/resolver.ts` 先做零模型候选，无论候选是否为空都会调用 `judgeLayer`（`packages/core/src/resolver/judge.ts` 的 `buildJudgeUserMessage` 在空候选时只输出 `candidates:\n(none)`），因此零候选时能否走出死路完全取决于模型是否主动给出 `next_queries`。据此在裁判提示里补了一条：空候选列表描述的是查询本身而不是项目，应返回 `sufficient=false` 加 2–3 个「1–3 个词」的索引项 `next_queries`，并在用户消息的空分支加了一行 `note: this layer returned no candidate. Rewrite the question into 1-3 short index terms...`（`packages/core/test/resolver/judge.test.ts` 新增一条断言钉住）。加入后的 24 回合实测与加入前同口径持平：should-recall 0.938、active 0.875、`usage_miss` 0.063、over-trigger 0.250、p50 13.4 s，即该改动在该样本量下未测出效果，属于「语义更明确、成本为零」的保留项而非已验证的改进；真正把冷场景从「搜索整句返回 0 条就放弃」变成「改写后答出」的仍是解析器模型（其六的对照）。另外，九个「组合记忆」样本暴露出评分口径错误：`score()` 用 `findIndex(id => expected.includes(id))` 判断命中，期望两条时命中一条就算 hit；现已改为全含才算命中，并把缺失项写进 `missing_expected_ids`，候选批第 3 批（174 条）因此从 `agree` 136 变为 133、`recall-gap` 4 变为 6。
其六，工具调用次数不等于答对，因此 `trigger.mjs` 给每个召回场景加了一条来自记忆正文的事实（`18080`、`第五步`、`删缓存`、`15`、`20`、`14`、`哈希`、`90`），把「注入了但没用上」独立记为 `usage_miss`；答案里出现拒绝措辞（没有找到 / 查不到 / 无结果 / 记忆库为空 / no matching memory）则记为 `miss`，因为那是一次检索失败而不是使用失败。首轮实测（未配置解析器模型）24 回合里 `usage_miss` 0.375，读答案发现机制是：模型拿整句自然语言去搜，合取匹配器返回 0 条，它据此回答「记忆库为空」就停住了。`memory_search` 的空结果原本只有一行 `(no matching memory)`，没有任何下一步提示，于是 `packages/pi-extension/src/tools.ts` 的空结果分支补了一行 hint，指明索引按整词（一元组与二元组，AND 连接）匹配、应改用问句里的 1–3 个词或改调 `memory_resolve`；`renderResolve` 的空结果同样补了 hint。同一实验给出的另一个数字是解析器模型的价值：固定其它条件、只切换 `--no-resolve-model`，12 回合口径下 should-recall 从 0.500 升到 0.875、`usage_miss` 从 0.125 降到 0.125（24 回合口径为 0.000），代价是 p50 从 8.7 s 升到 13.4 s、p95 从 21.3 s 升到 89.7 s。结论：解析器不是安慰话，它把「整句搜不到就放弃」变成「改写后答出」，但延迟翻倍以上，属于延迟换召回的交易。
其五，同名冲突场景下两条记忆都在候选集，排序先后不携带信息，样本用 `rank_ignored` 只断言存在性与 `conflicted` 状态，不参与 Recall 分母；这是记录口径，不是放宽标准。

对照第 12 节验收标准，当前状态如下（依据均来自上面的命令与报告，不是推断）：

| 第 12 节条目 | 状态 | 依据 |
| --- | --- | --- |
其八，触发器 harness 还抓到一个「覆盖」类问题：冷场景里有一条问「把服务打包成容器时镜像名字怎么起」的回合，`memory_search` 与 `memory_resolve` 都被调用了，却一条记忆都没返回，而答案所在的 `mem-docker-image` 就在库里。原因不是排序而是用词：那条记忆的关键词只写了「镜像标签」和 `image-tag`，正文讲的也是标签规则，从未出现「容器」「打包」，因此在词法检索层里它和用户的问法没有任何交集，裁判模型也无从改写。给这条记忆补上「容器」这个用户真会说的词（`CATALOG_VERSION` 5）后，同一条场景两次运行都转为命中（`--only cold-image-tag --repeats 2`：`miss(retrieval_miss)` → `hit hit`），而当时的离线基线不变，因为没有离线样本这样提问。这条差距正好落在第 4.8 节的 Memory Coverage 上：词法检索能查到什么，取决于记忆是用什么词写的，这是「记忆生成」的问题，而不是匹配器或排序的问题；把两条信号（离线基线 + 真实回合的 `retrieval_miss`）放在一起，就能把「库里没有」「库里有但找不到」「找到了但没用上」分开定位。

其九，离线侧新增了解析器观测面 `eval/memory/resolution.mjs`（7 条用例，裁判脚本化，不联网、不花钱、结果固定）。它逐条钉住 walk 的分支：第一轮就接受即 `resolved` 并停止；判证据不足且不给 `next_queries` 时只花一次裁判调用、`missing` 记 `evidence_insufficient`；给了改写词会重新 gather 并在第二轮 `resolved`；完全空 gather 且配置了模型时仍会花一次裁判调用；未配置模型时零调用、`missing` 记 `model_not_configured`；裁判输出无法解析会重试一次，之后 `missing` 以 `model_malformed_output` 开头。它暴露并用一次生产改动补掉了一个可诊断性缺口：空 gather 也会调用裁判，因此记录下来的 `missing` 原本只是裁判对空集合的结论（`evidence_insufficient`），「库里有这条记忆但从没匹配上」和「库里根本没有」在这一列同形。现在 `packages/core/src/resolver/resolver.ts` 的 `stopAssembly` 在整轮没有拿到任何卡片与历史摘录时额外追加 `no_candidates_gathered`，并且保留 `reason` 在首位，所以 `missing[0]` 的既有语义（`degraded_reason` 用的就是它）不变，而第 4.8 节 Memory Coverage 需要的区分变得可读；`packages/core/test/resolver/resolver.test.ts` 用正反两例钉住它（「nothing is found」必须带标记，「候选被裁判拒绝」不得带标记）。红绿验证：把 `judged.retryable && !retryUsed` 改成 `&& false` 停掉重试后，`res-malformed-judge` 立即变成 `judge_calls=1` 的 FAIL 并让脚本退出码为 1，改回后 7/7 通过。诚实边界也一并写进 README：裁判是脚本化的，因此改写用例只能证明「裁判给出的词会被重新检索并能救回」，把 `MAX_LAYER_GATHERS` 或 `MAX_LAYER_REQUERIES` 改成 0/1 并不会让它变红。

其十，真实回合侧的最后一个缺口由 `eval/memory/trace.mjs` 补上：它用 `replay.mjs` 为每个回合重建热点层计划（同一个固定 catalog、临时 store、`recordProjectInput` 之后的 `planInjection`），再合并 `out/trigger.json` 的 Agent 行为与 `out/usage.json` 的裁判判定，写出一条覆盖 trigger → hotspot → delivery → usage → cost 的 Trace（`out/trace.json`），因此「该查没查」「查了没交付」「交付了没用上」「注入了什么、是否带过期标记」都在同一条记录里可读。24 回合（`CATALOG_VERSION` 5，`magpie/auto/deepseek-v4.1-flash` + 本地解析器模型）实测：热点层注入 8 次（4 个热场景各 2 次），交付 15 次（8 热 + 8 冷中的 7 次），**Rescue Rate 0.875（8 条冷回合中 7 条最终命中）**，失败归因 trigger 0 / retrieval 1 / usage 0，总成本 $0.024278、每命中 $0.001619、p50 16.1 s、p95 39.2 s；唯一的 retrieval miss 是一次冷回合里 `memory_search` 与 `memory_resolve` 都调用了却什么都没交付，同一问句在别的回合能命中，属于解析与改写的波动而不是固定缺口。同一批数据也暴露了本目录里最不稳定的指标：over-trigger 在两次重复下先后测到 0.125、0.250、0.500，因为「hello world」「重命名标题」「ENOENT」这类无关问题有时也会触发检索，所以它只能当作「要单独看的场景清单」，`--only <id> --repeats N` 才是量它的正确方式。裁判一致性同样有批次波动：同一批 16 条真实回答，两次运行分别是 0.938 与 0.867（差 0.07，约一条判定），与人工集上的 0.833 一起说明它只适合看趋势。

其十一，Stale Misuse 从「只能测标记」推进到「能在真实回合上判别」：`mem-stale-ttl` 的摘要与正文只保留旧值（空闲会话 30 分钟），新值（15 分钟，2026-11-16 配置评审）只存在于 store 的 pending stale event 里，回合里 Agent 能看到的只有注入块上的 `⚠ 该摘要可能未吸收 1 条后续证据；memory_read 查看待处理详情`。判据因此是可判别的：答 30 且不提 15 记 `stale_misuse`，答 15（无论是否同时说明 30 已被取代）记命中——把「说出被取代的旧值」也判成误用是错的，`usage.mjs` 的裁判规则同样如此（`misused` 只在答案显示依赖了记忆却与记忆当前值冲突时成立）。实测两次重复：两次都调用 `memory_read`、读出 pending 事件、答出「现行 15 分钟，30 分钟已被取代」，`stale_misuse_rate` 0.000，说明 ⚠ 标记加读取工具确实把新值送到了答案里；样本量 2，只是给这条链路一个可回归的基线。同期把 over-trigger 从「跨批次不稳的比率」改成逐场景测量（4 个安静场景 × 3 次 = 12 回合）：重命名标题 1/3、解释索引 0/3、hello world 1/3、ENOENT 1/3，合计 3/12 = 0.250，每次触发都是一次 `memory_search`，代价是一次无效往返而不是错误答案；另外这批运行与另外两个 harness 共用同一个网关，p95 被抬到 117–202 s，因此延迟数字只能取自单独运行的那一批。

其十二，真实链路的第二个检索缺口在 Obelisk 侧，并且已经修复。Obelisk 的索引 `messages_fts` 不带 `tokenize`，因此走 SQLite 默认的 `unicode61`分词器：每一段连续的字母、数字、汉字各成一个 token，多字中文查询只有在「某个 token 恰好等于该词」时才命中，`灰度发布` 匹配不到 `下一批灰度发布` 所在的消息。修复落在调用侧：新增 `packages/source-obelisk/src/query.ts` 的 `expandFtsQuery()`，把每个词改写成前缀匹配（≥2 码位才加 `*`，单个汉字保持精确——一个汉字前缀能命中半个索引），带 FTS5 语法的查询原样通过（`"`、`*`、`(`、`)`、`^`、`:`、`~`、大小写敏感的 `AND`/`OR`/`NOT`/`NEAR`、词首 `-`/`+`），不重组、不加引号、不合成运算符。适配器的 `search()` 新增 `prefix_expand`（默认 true；`false` 用于 A/B），`query.text` 仍是调用者原话，新增 `query.fts_text` 记录真正发出去的字符串；`history-port.ts` 不传该选项，因此分层检索里的 history 层自动受益。经适配器对真实 6.97 GiB 索引、同一次运行内背靠背对比（`limit 50`）：重试策略 3→8、迁移脚本 23→44、灰度发布 29→39、空闲超时 17→21、端口约定 50→50（触顶）、itgc 12→12，单次调用都在 110–119 ms，前后无差别。一个必须记住的观测细节：真实索引在刷新时会吸收新会话（包括本次会话自己写下的文字），所以绝对条数会漂移——同一条 `重试策略` 早先测到 0→5、后来是 3→8——只有同一次运行里的成对数字可比。测试面：`test/unit/query.test.ts` 10 组用例（多字前缀、ASCII 词、内部连字符、单字不扩、标点裁剪、11 种显式语法原样通过、幂等、空串），`search.test.ts` 的 argv 断言改为发送 `zqleak*` 并新增 `prefix_expand: false` 与中文两例；`VESTIGIO_OBELISK_LIVE=1 vitest run test/live --testTimeout=120000` 10/10 通过（默认 5 秒超时会让 fixture 构建阶段超时，那是环境速度而非本次改动）。为什么不改上游：这正是「B 方案」，上游已有 issue #9（2026-07-30，至今 0 条维护者回复），实现 PR #14（opt-in `OBELISK_FTS_TOKENIZER`）在 2026-11-16 被维护者以「do not merge pending a later decision」关闭未合并，护栏 PR #78 与后续 #76/#194 同样卡着，main 的 `schema.sql` 至今 `messages_fts` 不带 `tokenize`，因此这条路只能在调用侧走完：不修改 Obelisk、不重建索引。

其十三，「查了但没命中」该不该在 gather 侧加兜底，用 `eval/memory/strategies.mjs` 量成了数字，结论是不加。工具对全部标注行（`cases.jsonl` 加三批候选，297 条带期望、117 条负样本）跑同一份临时 store 上的多种词法策略：`and` 是今天的生产口径；`or` 是 `mode: "any"`；`split` 把每个空格分隔的词单独查再并集（`memory_search` 的 920 次调用也来自这里）；`and_then_*` 只在 AND 返回空时才兜底，`hotspot` 变体兜底用的是注入面已经在用的匹配器（`matchHotspots` 遍历项目池，名字里的数字是 `min_score`）。实测（发现/命中旁的噪声 ID/负样本泄漏/兜底触发次数/检索调用）：`and` 99、10、0/117、0、414；`or` 283、2070、95/117、0、414；`split` 140、79、18/117、0、920；`and_then_split` 138、42、18/117、116、920；`and_then_or` 281、1507、94/117、116、414；`and_then_hotspot` 269、52、19/117、116、414；`and_then_hotspot_2` 266、52、17/117、116、414；`and_then_hotspot_3` 248、20、11/117、116、414。三条读法：其一，`or` 不是检索策略，它用一条记忆回答了 95/117 条负样本，因为它让「只共享一个词」的近邻问题看起来像命中；其二，兜底在 116/117 条负样本上都会触发，这不是调参问题而是结构问题——负样本之所以是负样本，正因为它们和任何记忆都没有整词交集，所以 AND 在这些行上必然为空，兜底因此永远是在没有 AND 所依赖的那个证据的情况下做决定；其三，两套人群给出的答案不一致，而这才是有用的发现：22 条手工负样本曾给出 0/22 泄漏，看起来像免费的收益，但那 22 条区分不出 0/22 与 11/117；把候选批里的近义否定样本人工复核后并入基线，负样本变成 38 条，同一个最严策略（`and_then_hotspot_3`）的答案是：找回 33 条字面 miss 里的 25 条（21/54 → 46/54），代价是 38 条负样本里泄漏 2 条（5.3%）并多带 3 个噪声 ID。也就是说「一败俱败」的问题被换成了一个可读的比率——约每 19 个本该安静的问题里有 1 个会拿到一条记忆。这个量级是否可接受，取决于我们还没测的那个不对称：错交付一条记忆的代价 vs 漏掉一条记忆的代价。要注意的是这个测量只覆盖词法层；对照物仍是已经在跑的模型改写路径（其十：52 次字面 miss 里救回 50 条、$0.0103），它只在真正空手而归的回合上花钱，空结果提示也让 Agent 在放弃前先用 1–3 个词重试。因此结论不变（先不落兜底），但理由从「负样本太少无法判定」换成了「缺的是代价不对称这一项测量」。

其十四，那项「代价不对称」现在有了一半数字。`trigger.mjs` 让场景声明 `contaminated_by: <memory-id>`，回合结束后把「用户问题 + Agent 回答 + 当时就在上下文里的那条记忆」交给裁判，只问两件事：`carried`（回答是否重述或采纳了这条记忆的内容）与 `harmed`（采纳是否让回答变得不正确或误导；只是多提一句无关信息算 `unclear`，不算 `yes`）。裁判看不到标签，`--no-judge` 可关。两批实测：near-miss 形态（`quiet-docker-nginx`，问「容器里怎么装 nginx」，而热点层因为「容器」是 `mem-docker-image` 的整词关键词而把它注入）8 回合 carried 3、harmed yes 0、unclear 2；冲突形态（`conflict-deploy-port`，问「部署脚本默认端口是多少」，注入计划会同时给出 `mem-deploy-port` 与两条互相矛盾的 `mem-port-rule-a`/`mem-port-rule-b`）3 回合 carried 3、harmed yes 0，但三次回答都拒绝给出端口，理由是「两条同主体记忆并列且没有可比较的时间/提交证据，不能替你选一个」。两条读法：其一，无关的近邻误交付不会自动变成错误答案，模型多数直接忽略，采纳时也只是多一段无关内容，所以「每 19 个该安静的问题泄漏 1 条」（其十三）不能被等同于「错误率 +5%」；其二，真正贵的是同主体冲突值，但代价不是答错而是**答不出来**——即使 `mem-deploy-port` 就在上下文里，两条冲突记录也会让 Agent 选择澄清而不是给值，这正是第 10 节诊断矩阵里「多条记忆冲突 → 版本和事实关系不足 → Conflict Resolution」那一行，现在有了可复现的观测面。诚实边界：`fact` 判据是子串命中，所以 `conflict-deploy-port` 三回合都记 `hit`/`used=true`（18080 出现在回答里），只有裁判才指出结论是「未知」；冲突形态的 n=3、near-miss 的 n=8 都只是方法加基线，还不能当比率用。

其十五，真实 session 的观测面也已经接上，而且不需要新的生产通道：`packages/pi-extension/src/decision-log.ts` 的 decision log 原本就是「按需开启的诊断日志」，这轮只给记录补了 `memory_ids`、`matched_ids`、`query_hash`、`query_chars`（仍然只有标识、计数、耗时，没有正文和问句），`eval/memory/shadow.mjs` 再按 session 与 `input_id` 把 input / tool_search / tool_resolve / tool_read 拼成一条 trace 并输出不需要标签的比率。端到端验证用的是 `trigger.mjs --decision-log <path>` 产出的真实三回合日志：一条冷问题走成 `no_match → tool_search(not_found, cards=0) → tool_resolve(resolved, mem-conn-pool) → tool_read`，一条「容器里怎么装 nginx」被热点层注入了 `mem-docker-image`（一次真实的误交付），一条 hello world 保持安静；`shadow.mjs` 报出 3 turns / 1 injected、交付后调用工具 100%、读了正文 100%、未交付时主动检索 50%、gather 零命中 50%、`top_injected mem-docker-image×1`、input handler p50 5.77 ms。这里有一个新的可观测代价：误交付并不是「白给一段文本」——那一回合 Agent 因此多调用了一次 `memory_read`（把无关记忆的正文也读进了上下文），所以误交付的成本可以用「多一次 read + 其 token」直接计量，而不用只靠裁判判「答案是否变坏」。诚实边界：样本只有 3 回合，比率只是管线验证；`shadow.mjs` 无标签，因此它不报 Recall（那仍归 `run.mjs`/`trace.mjs`）；抽样与容量限制都在日志之后执行，生产侧不知道也不可能被它拖慢。

其十六，同名冲突到底是「呈现缺证据」还是「数据没记录」也已经问了：产品本来就有记录替代关系的地方——pending stale event，所以实验就是把这条替代关系记上，再问同一个问题。`trigger.mjs --stale-port-rule` 只给较旧的 `mem-port-rule-a` 补一条 stale 事件（「2026-11-18 的评审把端口约定改成 18080，旧的 8080 仅保留一周」），检索、注入、问题全部不动；同时给场景加了 `decided_fact`，因为子串判据分不清「给出一个值」和「并列候选后表示无法确定」，只有裁判能。结果：不记替代关系时 3/3 拒绝（0/3 committed），记上之后 2/3 明确结论为 18080、并逐条列出证据（`mem-port-rule-b` 现行、`mem-port-rule-a` 标 STALE 且带后续证据、`mem-deploy-port` 只记录两者要一起改），原文说「这是一次已生效的后续变更，按规则它取代较早的 8080」；第三回合仍然拒绝，而它的回答只报告了 `mem-deploy-port` 的 freshness（current、无 pending），完全没提 `rule-a` 的 stale 事件，所以它的失败点是自己没去读那条 pending 详情，而不是标记缺失。结论：同名冲突的修法在**数据**——用既有的 stale 事件记录谁替代了谁，不需要新 schema——检索层的 `conflicted` 状态加每条 freshness 已经够 Agent 推理；这仍然只是方法加方向信号（每臂 3 回合、一个问题），而且那两次跑在网关争用下 p50 约 260 秒，延迟数字不可引用。

| 1 固定 Dataset 重复运行 | 已满足 | 95 条样本 + 固定 catalog + 临时 store，两次运行除 `generated_at` 外字节一致 |
| 2 区分四类 Miss | 已满足 | Trigger Miss 由 `trigger.mjs` 的 `failures.trigger_miss` 给出，Retrieval Miss 由同处的 `retrieval_miss`（调了工具但没有任何 `memory://` 交付）与离线 `miss` 给出，Usage Miss 由 `usage.mjs` / `trigger.mjs` 的 `usage_miss` 给出，Resolution Miss 由 `resolution.mjs` 的 7 条解析器用例按分支固定（裁判脚本化，不依赖模型状态） |
| 3 Recall@1/3/5 | 已满足 | 当前均 0.925，分母为带期望 ID 且未标 `rank_ignored` 的样本 |
| 4 Candidate / Injection FP 分层 | 已满足 | 两个比率共用分母，另有 `budget_rescued` 计数据 |
| 5 Memory Gap 与 Retrieval Miss 分离 | 已满足 | `history-rescue-gray-release` 期望 ID 为空、以 `expected_source_refs` 命中，说明记忆库没有而原始历史有 |
| 6 过期记忆的错误使用 | 部分 | 过期标记可测（`inject-stale-flagged`）；真实回合侧新增可判别的过期场景与 `stale_misuse_rate`（实测 0.000，n=2），见其十一；样本量仍太小 |
| 7 一次完整查询的 Trace | 已满足 | 离线报告覆盖单次查询的分层状态、候选、注入、引用；跨回合串联由 `eval/memory/trace.mjs` 完成：它对每个真实回合重建热点层计划（`replay.mjs`）、合并 Agent 行为与裁判判定，输出一条覆盖 trigger → hotspot → delivery → usage → cost 的 JSON Trace（`out/trace.json`） |
| 8 比较两个 Git Commit | 已满足 | 报告写入 `commit`、`catalog_version`、`dataset_sha256`；`compare.mjs --baseline=<git-ref>` 直接用 `git show <ref>:eval/memory/baseline.json` 取旧版本的基线，不必再切 worktree（实测 `--baseline=bd4a4ae` 输出 `added in candidate: 34`、无回归） |
| 9 P50/P95 与有效召回成本 | 已满足 | 离线 harness 不调用模型、不做索引，因此计时与 token 挂在真实链路上：`trigger.mjs` 报 P50/P95 与总成本并新增 `cost_per_hit_usd`，`usage.mjs` 报每次判定成本。24 回合实测：总 $0.024278、$0.001619 / 命中、p50 16.1 s、p95 39.2 s。生产路径上的完整成本仍要等 shadow 埋点 |
| 10 Shadow 不改变生产行为 | 已满足 | 观测通道是既有的 `VESTIGIO_DECISION_LOG`（默认关闭、写失败不抛、只记标识与计数），评估在日志之后由 `eval/memory/shadow.mjs` 离线完成：不阻塞 hook、不回写 store、不调用模型 |
| 11 评估失败不影响记忆读写 | 已满足 | 工具未接入生产路径，失败只体现为自身退出码 |
| 12 结果可追溯 | 已满足 | 离线报告写 `commit` / `catalog_version` / `dataset_sha256`，真实链路报告再写 `model` 与 `resolver_model`，`usage.mjs` 写裁判模型与成本 |

第二个实验问的是「自然语言入口该不该走 OR 检索」。把 6 条卡片查询改写成自然问句（保存为 `eval/memory/experiments/nl-cases.jsonl`，`run.mjs --cases` 可直接跑）后：

| 检索口径 | Recall@1 | Recall@3 | `false_positive_rate` | 未命中 |
| --- | --- | --- | --- | --- |
| 生产默认（`AND`） | 0.556 | 0.556 | 0.111 | 5 条零命中 |
| 临时改为 `OR`（`store.ts:1452` 的 `?? "any"`） | 1.000 | 1.000 | 0.222 | 0 条 |

`AND` 口径下 `部署脚本默认端口是多少？`、`迁移失败以后该怎么回滚？`、`读路径回填缓存为什么会抖动？`、`另一个项目的部署端口是多少？`、`端口约定到底该按哪个来？` 全部零命中，这正是用户用自然语言提问时的真实体验。改成 `OR` 后召回补齐，但当时那 8 条记忆里有 6 条同时进入 `limit: 10` 的结果（该组数字在 catalog 扩到 20 条之前测得），`search-implicit-migration` 与 `search-cache` 转为误注入，`从没记录过的问题` 命中 6 条记忆（`expected_status: not_found` 不再成立），多数 `search` 结果状态退化为 `conflicted`。

结论：OR 不是自然语言的解法，它只是把排序问题暴露在结果集长度上；FTS 没有可靠排序时，把检索口径放宽到 `OR` 等于放弃精度。自然语言入口应留在 `memory_resolve`（由模型选择证据），`memory_search` 保持关键词契约。实验后 `store.ts` 已改回，`git diff` 为空。

第三个实验在使用侧。`eval/memory/usage.mjs` 把「(用户问题, 注入的 nav 摘要, Agent 回答)」交给一个裁判模型，要求给出 `used` / `partial` / `ignored` / `misused`，再和人工标签比对。裁判走 `pi -p --no-tools`，模型借自 `~/.pstack/models.md` 的 `feature, refactoring` 行，`magpie/auto/deepseek-v4.1-flash:low`；因为是真调用，报告里的 `duration_ms`、输入输出 token 和 `cost_usd` 都是实测值——一次判定约 `$0.00017`，12 条一轮约 `$0.002`，P50 约 2.2–2.4 秒。

一致性一开始只有 0.583，原因不是模型弱，而是标签口径含糊：把「复述 nav 里的具体内容」和「只说该看看记忆」混成了同一个 `used`，裁判按字面判成了 `partial`；把 `misused` 限定为「依赖了记忆但结论相反或把过期内容当现状」之后，答案改成显式复述，一致性升到 0.833。同一份样本再跑一次是 0.750，12 条里有 1 条判定翻转（`usage-deploy-port-used` 从 `used` 变 `partial`）。因此这个裁判适合做趋势观测，不能做单例门禁；把它当门禁会被裁判噪声当成回归。`usage-stale-ttl-*` 三行同时补上了 Stale Misuse 的正样本：同一条带 `is_stale` 的记忆，分别对应「据此修正」「无视」「把旧值当现状」。

真实模型质量、历史快照回放、跨版本配对基线及 Shadow 副作用仍是后续验收项。
