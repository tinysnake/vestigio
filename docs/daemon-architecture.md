# Vestigio daemon 架构提案

目标是让 Vestigio 按需启动并独立常驻。pi、CLI 和 MCP 都是客户端。服务端持有模型调用、任务调度、记忆写入和结果交付。本文记录已实现的设计；进程、懒启动、调度、交付和停机的行为由 `packages/daemon/test/` 与 `scripts/daemon-smoke.mjs` 验证。

## 设计依据

[issue #1](https://github.com/tinysnake/vestigio/issues/1) 描述了 turn 与后台任务的耦合。当前 `packages/pi-extension/src/extension.ts:84` 的 `agent_end` 等待 stale detector 和 repair，并把 checkpoint/report 写回 pi session。`packages/pi-extension/src/tools.ts:191` 的 resolve 调用及其后续 publication 也会写入记忆。因此，迁移范围包括所有调用方及写入路径。

方案采用单个本机服务和现有 SQLite，不引入 Redis、外部任务平台或微服务。一个 daemon 对应一个规范化后的 data root，服务其中所有项目。多个项目共享记忆时，属于同一个写入域。并发上限按 daemon 生效，后续可在同一调度器中增加项目公平性。

## 进程和模块边界

```text
pi extension             CLI            MCP adapter
     |                    |                 |
     +------- @vestigio/client -------------+
          ensureDaemon + HTTP client
                     |
                daemon service
          API + durable jobs/results
                     |
    search pool | detector pool | maintenance queue
                     |
           core domain + SQLite storage
```

建议新增 `packages/client` 和 `packages/daemon`。pi extension 直接导入 client，不调用 CLI、不经过 MCP。client 在本机负责按需启动独立 daemon，再通过 HTTP 与它通信，结果通知使用 HTTP 流。CLI 和 MCP adapter 为不支持 extensions 的 agent 提供兼容入口，共享 client、领域服务和存储，不另建 scheduler。

`packages/core` 保留记忆领域、检索、修订和存储能力。`packages/model-client` 保留模型协议。pi extension 负责采集 session/branch/turn 上下文、自动触发任务、接收完整结果并在合适时机注入。它不持有服务端数据库连接、模型执行器和后台 worker。CLI 和 MCP 的运行期写操作也必须走 daemon。

## 懒启动和退出

`ensureDaemon(dataRoot)` 由本机共享 client 执行，pi extension、CLI 和 MCP adapter 都可直接调用它。先检查服务身份与健康状态。未运行时，直接启动该 data root 对应的独立后台进程，然后等待 ready。ready 必须晚于 schema 校验、恢复对账、配置加载和监听端口建立。启动等待有上限，超时只结束本次连接等待，不取消已经接受的业务任务。

不注册 launchd/systemd 服务，不做崩溃自动重启或开机自启。daemon 崩溃后，已接受任务保留在数据库，等待下一次 extension、CLI 或 MCP 调用通过 client 启动进程并恢复；崩溃后若没有新调用，任务保持暂停。正常运行的 daemon 即使所有调用方离线也继续执行任务。启动方与 daemon 不共享退出生命周期，标准输入输出及日志需独立处理，调用方退出不停止 daemon。原始 HTTP 请求本身无法启动未运行的进程，但本机 extension 在发 HTTP 请求前可由 client 启动进程，无须借助 CLI 或 MCP。

启动时先取得由内核随进程退出而释放的排他锁，再打开数据库并写入 instanceId。恢复完成前不创建执行池、不接受任务。恢复只能接管已确认终止的旧实例；暂停或失联不足以证明旧实例死亡。锁不可靠或不可用时启动失败，不能改用 PID/端口探测强行接管。所有发布都校验 `(ownerInstanceId, attemptId)`，停止或失去执行权的实例无权再提交。

服务启动后没有 idle timeout。关闭 pi、切换 session、关闭 MCP 连接均不触发退出。API 断线只关闭请求或订阅，不隐式取消已接受的任务。机器休眠期间任务暂停；恢复后继续或按明确的传输错误处理。

管理命令建议为 `vestigio daemon start|status|stop`。默认 stop 停止调度并中断当前执行，把可恢复任务保存为 queued，然后退出。中断是一次 attempt 的结束，不伪装成任务成功或失败。可另提供 `stop --drain`，等待在途任务完成；由于任务没有运行时限，drain 也不承诺有限等待。`job cancel` 才把指定任务置为 cancelled，并生成终态通知。下一次 extension、CLI 或 MCP 调用通过 client 按需启动服务。

## 数据和状态机

服务端先定义下列数据，再实现执行逻辑。

```ts
type JobKind = "search" | "stale_detection" | "maintenance";
type JobState = "queued" | "running" | "waiting" |
  "succeeded" | "failed" | "cancelled";

type JobInput =
  | { kind: "search"; input: SearchInput }
  | { kind: "stale_detection"; input: DetectionSnapshot }
  | { kind: "maintenance"; input: MaintenanceCommand };

type SessionKey = {
  source: string;
  sessionId: string;
};

type Job = {
  id: JobId;
  sessionKey: SessionKey;
  requestId: RequestId;
  input: JobInput;
  context: { projectId: string; branchRef?: string };
  state: JobState;
  attemptId?: AttemptId;
  nextRunAt?: string;
  dependsOn?: JobId;
};
```

输入类型按任务种类区分，结果类型也按任务种类区分。数据库保存 payload 版本及内容哈希，在 API 边界验证。不能通过一个任意 JSON 字段加散落的条件判断约束领域。

session 是任务归属单位。source 是 invoker 自定的来源命名空间，与使用 HTTP、CLI 或 MCP 无关；入口只验证其格式和长度，不枚举来源。pi 使用其真实 sessionId；其他 invoker 提供自身逻辑 sessionId。daemon 用来源与 sessionId 区分身份，在 `sessions` 表中规范化成内部 sessionRef，job 和关联记录引用 sessionRef，避免每行重复长 session 标识。派生任务继承父任务 session，不引入跨 session 的“pi 客户端 inbox”。

持久化区分执行数据、短期结果与通知、长期简短结果记录。`jobs` 和 `job_attempts` 保存执行与恢复所需的数据；`job_results` 保存等待交付或到期清理的详细结果；`session_notifications` 保存等待发送的通知；`job_summaries` 每个终态 job 只保留一条简短记录。任务终态、简短记录和终态通知在同一个 SQLite 事务中提交。每个 job 只有一个可见终态，多次 attempt 可以分别记录，但 attempt 明细不长期保留。状态转换用当前 state 和 attemptId 作条件更新，迟到的旧 attempt 无权提交。

`(sessionRef, requestId)` 是提交幂等键。相同键与相同内容返回原 jobId，相同键与不同内容返回冲突。客户端在收到响应前断线，可重发原请求。服务只有在任务及必要输入已持久化后才返回 accepted。详细结果清理后，用简短记录关联的精简幂等键及输入摘要识别重试；不会无限保留原始请求、全部事件和完整 attempt。session 被明确删除后的清理统一回收这些记录，并拒绝向已删除 session 继续提交任务。

`waiting` 表示依赖子任务，不占执行池 permit。重试保留原 jobId，另建 attempt。恢复时先取得独占权并确认旧执行实例结束，再对账旧 running attempt。不能只因心跳或固定 lease 到期就启动第二个维护 agent。

## 调度和写入一致性

| 类别 | 执行模式 | 变更记忆的权限 |
| --- | --- | --- |
| maintenance | 一个队列，最多一个执行中的维护工作流 | 经统一 publication 边界提交 |
| stale detection | 独立可配置并发池 | 产生检测证据或维护命令 |
| memory search / resolve | 独立可配置并发池 | 只读检索，写入意图转交维护队列 |

maintenance 的初始并发固定为 1。detector/search 的初始建议上限分别为 2 和 4，属于配置起点，未经性能测量。HTTP 接入和结果投递不占这些 permit。队列达到容量上限时，接受前明确拒绝；已接受任务不因排队时间长而丢弃。一个健康的长维护任务会阻塞后续维护，这是串行执行与无运行时限共同带来的限制，不能用优先级承诺消除。

repair、主动记忆编写、合并、摘要重写、导航发布和具有语义影响的 stale 状态变更都经过统一记忆写入边界。search 和 detector 可以写独立的 job/evidence/access 元数据，但不能绕过边界修改记忆内容或 head。

`memory_resolve` 从历史生成的候选记忆先保存在该 job 的独立结果中，再生成 maintenance 子任务。若其最终结果包含“已保存记忆”，父任务进入 waiting，释放 search permit，等待子任务完成后才终结。maintenance 自己的提交直接使用当前维护执行权，不能排队一个需要同一执行权的子任务并等待它。这样避免队列自锁。

agent 执行期间不持有 SQLite 写事务。读取时捕获相关 memory revision、证据范围和必要的导航版本；慢模型调用在事务外执行。提交时校验候选结果的基础 revision。过期候选重算或重新排队，不覆盖更新后的 head。stale 检测也只能应用于它实际检查的 revision。

正文、修订、导航和搜索索引继续使用现有 SQLite 存储。记忆发布、关联 job 的状态变更和 outbox 在一个事务中提交，不引入新的正文文件系统。保留 `MemoryState` 的 `medium_ready | published | archived` 契约，导航进度保存在 job 中，`medium_ready` 正文继续可检索。

search 的 usage、注入回执等运行记录由 daemon 的短事务写入，不占 maintenance agent 的执行名额。前台热点读取也改用 client API。resolve 的 continuation 和调用预算移入服务端，使用独立 context handle 与版本管理；并发更新同一 handle 必须条件提交，不能让旧结果覆盖新 continuation。预算原子扣减，不沿用前台运行时间截止。

入队和完成事件驱动调度，服务启动时扫描未完成记录，并在服务内定期对账持久待办。周期对账不依赖 `agent_end`，只负责发现遗漏并以幂等键入队，不对健康长任务进行到期重启。

## pi extension 的完整接入

pi 使用 extensions 模式，直接调用 @vestigio/client。MCP 的能力限制不影响 pi 路径。extension 监听真实 session、branch、input 和 turn 生命周期，采集检测证据并提交任务；agent_end 只提交，不等待检测或维护结束。前台记忆工具、热点读取和异步结果注入均通过 client 访问 daemon。

extension 为当前 session 建立 HTTP 通知流，接收完整通知和结果。daemon 成功发送后清理通知和详细结果，不要求 ACK 或第二次取结果。切换 session 时关闭旧流并连接新 session，重开时接收仍在保留期内的待发通知，并按需查询长期 job 记录。通知不能触发向错误 session/branch 注入。流断开不停止任务，也不要求客户端持久 inbox。

底层使用 loopback HTTP + JSON，通知可采用 SSE。监听地址、协议版本和鉴权材料写入用户私有 runtime 目录，边界校验访问令牌、Host 和 Origin。source/sessionId 显式携带，不从 TCP 连接推断。

| 接口 | 语义 |
| --- | --- |
| `POST /v1/jobs` | 提交并返回 202、jobId |
| `GET /v1/jobs/:id` | 查询执行状态、详细结果或简短记录，不触发通知清理 |
| `GET /v1/sessions/:sessionRef/jobs?after=cursor` | 按 session 分页查询 |
| `POST /v1/jobs/:id/cancel` | 显式取消 |
| `GET /v1/sessions/:sessionRef/events` | 发送完整通知及结果，成功发送后清理；支持实时流和有界批量读取 |
| `GET /v1/health` | 身份、版本和就绪状态 |

accepted 是请求与业务任务的持久化分界。提交响应丢失后用原业务 requestId 重试。取消等待或关闭通知流不取消 job。

## CLI 与 MCP 的兼容范围

CLI 和 MCP 面向不支持 extensions 的 agent，提供显式操作能力，不声称能获得宿主的完整会话上下文或接管宿主生命周期。invoker 指定 source/sessionId；不提供真实 session 对应关系时，daemon 无法恢复它与原 agent 对话的关联。source 仍是任意合法字符串，不由入口固定为 cli 或 mcp。

| 能力 | pi extension | MCP adapter | CLI |
| --- | --- | --- | --- |
| 本机按需启动 daemon | 直接调用 client | adapter 调用 client | 命令调用 client |
| 提交三类任务、查状态/结果、取消 | 支持 | 工具显式调用 | 命令显式调用 |
| 真实 session/branch/turn 上下文采集 | 自动采集 | 不自动采集，invoker 传入 | 不自动采集，命令参数或输入提供 |
| turn 结束时自动提交 stale detection | 支持 | 不支持宿主 hook，须显式提交证据 | 不支持宿主 hook，须显式提交证据 |
| 前台热点自动读取与上下文注入 | 支持 | 不支持自动注入，由宿主自行使用工具结果 | 不支持自动注入，由调用方使用命令输出 |
| 实时完整结果通知 | HTTP 流直接发送完整结果 | 支持订阅的宿主可收到资源变更提示，仍须取完整结果 | 仅显式 watch/等待命令存活期间接收，命令退出后不推送 |
| 重开同一 session 查询记录 | 自动关联真实 session | invoker 重传相同身份后查询 | 传入相同身份后查询 |
| branch 匹配、晚到结果安全注入 | extension 处理 | 不支持，由宿主处理 | 不支持，由调用方处理 |
| 识别宿主 session 是否已删除 | 后续 pi 专用清理机制接入 | 不自动识别，后续需 invoker 提供可信删除信息 | 不自动识别，后续需显式提供删除信息 |

兼容入口缺少上下文或历史访问条件时，显式报告缺失能力。不能把空证据运行当成已完成同等检测。daemon 自身拥有的历史 adapter 可继续使用，但不能代替未提供的宿主即时上下文。后台任务接受后，其执行、串行写入、结果记录和清理规则与 pi 路径相同。

## MCP 协议适配

MCP 工具提供 job_submit、job_get、job_list、job_cancel、events_receive，以及本地工具 project_id（解析某目录的规范 project id，不依赖 store 或 daemon；同一仓库的每个 worktree 共享同一 id，子模块取 `<superproject id>/<相对路径>`，所以超项目每个 worktree 得到同一 id；最近一层 `.vestigio/settings.json` 可声明 `project` 作用域，文件损坏是错误而不是回退）。job_submit 立即返回 jobId；events_receive 按 session 有界批量返回完整通知和结果，成功发送后清理，无待发项立即返回。job_get 是查询，不触发投递清理。不要求 invoker ACK。

MCP 2026-07-28 是无状态协议，每次请求携带所需元数据和业务标识，不依赖初始化握手、协议 session 或复用同一连接。跨调用的 jobId 和业务 requestId 显式传入。pi extension 不使用这些 MCP 工具。

后续若增加 MCP 资源订阅，adapter 可以通过 `subscriptions/listen` 和 `notifications/resources/updated` 提示有结果待领取。标准提示只携带 URI，不能据此删除结果。当前 stdio adapter 提供 `events_receive`，由宿主主动领取完整结果。重连后也由宿主主动领取。

stdio adapter 需在完整工具响应成功写出给 invoker 后，再完成 daemon 内部清理，不能把 daemon 到 adapter 的内部发送当作最终交付。内部完成信号自动处理，不是 invoker 的 ACK API；该边界崩溃可导致重复投递。MCP Tasks 扩展暂不作为依赖。

## CLI 结果交付

CLI 提供提交、查询、列表、取消和显式 watch/领取命令。提交后命令退出不停止任务；仅命令在运行并执行 watch/等待时能接收实时结果。完整结果成功写入 stdout 后才完成内部投递清理。写出失败则保留待发结果直至重试或到期。成功写出不保证下游 agent 实际消费，清理后仍可查询精简 job 记录。CLI 不自行把结果注入宿主对话，也不启动另一个持久通知进程。

## 结果记录、通知与 session 归属

pi 按 session 接收通知，不设置独立的 pi 客户端 inbox 或用户管理 inbox。一个 session 的通知可通过一条订阅请求接收，同一传输也可以处理不同 session 的请求；连接身份不能用作 session 身份。所有待投递状态和结果都由 daemon 持久化，pi 扩展只负责接收、处理或忽略，无须 ACK。

每个已接受任务到达 succeeded、failed 或 cancelled 时，必须生成简短结果记录和发往所属 session 的终态通知。pi extension 在线时由 daemon 主动发送完整结果；MCP 和 CLI 按兼容范围提供提示或领取，不能将其描述为所有宿主均支持完整主动推送。没有接收方时保留待投递通知；发送失败且未过期时保留供重试。客户端可按 eventId 去重；成功发送完整结果即由服务端视为已处理。取消的详细结果记录已经提交的 effects，取消停止后续工作，不声称撤销已发布记忆。同一 session 的投递和领取由 daemon 协调，避免并发消费者同时争用同一通知。

通知和详细结果共享短期生命周期，简短记录独立长期保留。

| 数据 | 内容与清理规则 |
| --- | --- |
| 执行数据 | 未终结任务保存执行和恢复必需的数据，不因通知期限而清理 |
| 详细结果 | 保存完整结构化返回值；随通知成功发送后立即回收，未发送则在通知期限到达时一起清理 |
| 待处理通知 | 保存 jobId、eventId、投递状态与 expiresAt；发送时携带完整结果，成功发送或到期时，与详细结果一起回收 |
| 简短结果记录 | 每个终态 job 一行，session 尚未删除时保留，供长时间后重新打开同一 session 查询 |
| attempt、进度和诊断明细 | 仅短期保留，不成为永久增长的审计日志 |

简短结果记录只含 jobId、sessionRef、任务类别、终态、完成时间和固定枚举的 resultCode。详细结果清理后，仍可查询任务成功、失败或取消，以及对应的结构化结果码。长期记录不包含自然语言结果说明、输入输出正文、完整堆栈或变更清单，也不需要为记录额外调用模型。

`job_summaries` 使用规范化 sessionRef、紧凑的状态/类别编码及数值时间戳，索引只服务 jobId 查询和 session 分页。终态清理后不再并存一份同样大的历史 jobs 行、永久事件流或完整 attempt，精简幂等键可并入结果记录。简短记录仍随 job 数量线性增长，最终由 session 级清理回收，不承诺无限数量下的固定磁盘占用。

session 重新打开时，以原 session 身份订阅并领取尚未过期的通知，也可分页查询 job 简短记录。通知到期不代表任务失败，详细结果清理也不代表结果未知。查询响应明确区分 active、full 与 summary_only；已删除 session 不再提供这些记录。分页 cursor 仅用于任务记录查询，通知领取从当前待发送集合取数据，不依赖永久事件历史。通知 expiresAt 在生成时确定，不因重试或重复连接无限延长。

delivered 定义为完整通知及详细结果已通过发送接口成功写出，且发送过程中未报告连接错误，由 daemon 单方面判定，不要求客户端 ACK。不只发送结果引用，否则服务端清理后客户端可能无法取得内容。发送成功后，daemon 在同一个事务中回收通知和详细结果，保留简短记录。若父任务仍依赖子任务数据，须先交给父任务的执行状态，不能借客户端通知维持内部依赖。

此定义不保证客户端应用实际消费；发送成功后客户端立即退出，仍可能只剩简短记录可查。发送成功与清理事务之间崩溃，也可能在恢复后重复发送。不承诺恰好一次交付。若通知发送前就过期，daemon 同样清理通知和详细结果。会话切换不会取消后台任务；扩展只向当前匹配的 session/branch 注入内容，不将旧会话结果注入新会话。

没有运行时限意味着合法任务可以长期 running。保证是每次终态转换都有简短记录和通知，并在通知保留期内主动尝试投递，不承诺所有模型调用都会在有限时间内完成。明显的网络失败按错误类别重试或失败；正常长运行不因累计耗时而失败。连接建立、单次网络故障检测、启动等待和 worker 存活探测均不能充当隐含的 agent 总时限。

## 为 session 级清理保留关系

所有 job、派生任务、详细结果、通知及简短记录都能按 sessionRef 定位。记忆保存来源 session 的关联，使用来源关系表达多个 session 共同提供证据的情况，不把来源 session 等同于记忆的独占所有者。后续清理无需扫描任意 payload 或解析日志推断归属。

session 断线、长时间不活跃与通知过期均不等于 session 已删除。未来清理机制须由可信来源确认 session 删除，并记录删除状态。清理前禁止该 session 继续接收或派生任务，取消或安全终结未完成任务，并让 publication 校验 session 状态，防止旧 worker 在清理后重新创建记录。之后分批清理 job、幂等键、结果、通知及来源关联，清理可以重复执行。

相关记忆不能按“被这个 session 用过”直接级联删除。共享记忆先移除已删 session 的来源关系，保留仍有其他来源或保留依据的内容；失去全部依据的记忆进入后续清理或重新维护流程。具体删除策略留给后续清理机制，本次仅建立可追溯的关系和索引，不执行 session 或记忆删除。

## 凭证和上下文

daemon 独立读取自己的模型配置和凭证，并复用现有 model-client。不能在 pi 结束后继续依赖 pi session 中的 provider 对象、临时 key 或 MCP sampling。

提交时持久化所需证据、来源定位及其版本。历史检索通过 daemon 自己的 history adapter 访问。需要的输入不能只保存在 sessionManager 的内存对象里。配置变化走显式 reload 或 restart，不能让不同客户端通过环境变量悄悄改变同一个 daemon 的配置。

## 实施顺序及验收

1. 先完成 job/result/delivery 契约、schema、状态转换及失败注入验证。验证 accepted 后杀进程，重启仍能找回同一个任务。
2. 建立 daemon、懒启动、单实例、显式 stop 和 HTTP client。验证多个客户端同时首调只有一个执行实例，关闭启动它的 pi 后进程继续工作。
3. 将三类 agent 和所有记忆写入迁移到 scheduler。验证维护并发不超过 1，另两类遵守各自上限，慢模型期间检索与状态接口可用。
4. 优先切换 pi extension 的直接 client 接入及 HTTP 完整结果流，统一迁移旧 pending/processing 记录。保留未完成任务、幂等键和来源证据，删除 session 驱动的 drain/checkpoint/report 和进程内模型执行路径。验证 session/branch 切换、自动检测提交、热点注入及晚到结果路由，不依赖 MCP 或 CLI。
5. 添加 CLI 和 MCP 兼容入口，验证显式上下文提交、缺失能力报告、MCP 提示不触发清理、领取完整结果成功发送后才清理，以及 CLI/adapter 最终写出前不清理。按能力表逐项标记支持或不支持，不以通用工具可调用替代 pi extension 行为验证。
6. 验证成功发送后通知和详细结果立即回收、未发送通知到期后与详细结果一同清理、清理后同一 session 仍可查到简短结果、session 很久后重开不依赖旧通知、派生任务继承 session，以及共享记忆的来源关系不会被误解为独占归属。

运行验证还须覆盖任务接受、记忆发布事务提交以及通知发送/清理前后的崩溃，断言无重复记忆、无过期覆盖、无终态简短记录丢失，并验证发送后清理前崩溃允许重复通知。故意让 agent 超过旧 detector/repair 时限，确认仍然运行并最终发送结果。默认 stop 后任务可恢复，显式 cancel 则有 cancelled 结果。额外验证 SIGSTOP 超过旧 lease 时限后仍无第二个维护执行者、第二个 daemon 在打开执行池前退出、任务执行不依赖 MCP handle TTL，以及导航生成中断后 medium_ready 正文仍然可检索。

上述门槛已有自动化覆盖的部分：第 1 条由 `packages/daemon/test/jobs.test.ts` 的重启、取消和交付回收用例覆盖；第 2 条由 `packages/daemon/test/process.test.ts` 的单实例与崩溃接管用例覆盖，`scripts/daemon-smoke.mjs` 走一遍 CLI、daemon、stop 的真实路径；第 3、4 条由 `packages/daemon/test/memory/` 与 `eval/pi/run.mjs` 的真实 pi 场景覆盖；第 5 条由 `packages/cli/test/daemon.test.ts` 的 relay 与写失败用例覆盖。第 6 条的通知与详细结果清理逻辑由 job 用例用假时钟覆盖，不是进程崩溃后再读。尚无自动化或手工证据的部分：session 很久后重开、SIGSTOP 超过旧 lease 时限后仍无第二个维护者、第二个 daemon 在打开执行池前退出、任务执行不依赖 MCP handle TTL，以及记忆发布事务提交和通知发送/清理前后的真实崩溃。`scripts/daemon-smoke.mjs` 只走 CLI 建库、首次 `get` 触发懒启动、状态文件与 `stop`；README 里的 pi 启动与配置路径不在它的覆盖内。现有真实 pi 验证入口继续保留，用于验证客户端提交与结果注入；daemon 生命周期另有直接启动真实服务进程的集成验证。

## 原则对具体决策的影响

- Foundational Thinking。先定义 Job、Attempt、Result 和 Delivery 的归属，再分协议和 worker。session 是归属单位，短期通知与长期简短结果记录分别存储。
- Make Operations Idempotent。启动、提交、发布、终态提交和通知清理都能在崩溃或重试后收敛。通知清理不清除任务结论，未来 session 清理须可分批重试。
- Separate Before Serializing Shared State。每个 agent 先拥有独立候选结果，真正共享的记忆发布才进入串行维护边界。

## 协议资料

- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/seps/2663-tasks-extension.mdx
- https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions
