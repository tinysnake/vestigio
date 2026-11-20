# Pi 记忆搜索如何处理空结果

`memory_search` 先按原查询做严格匹配。首个结果页既没有卡片也没有历史摘录时，Pi 会把当前用户问题交给补救流程。配置了模型时，补救最多生成三个短查询，每个仍走严格匹配。同时，SQLite FTS5 对原查询做一次 BM25 排序，取请求上限内的部分匹配。中英文附加词缺失时，其余词仍可提供候选。其他记忆碰巧包含附加词时，这一查法也能工作。

模型按原问题核验候选的主题、具体属性和项目范围。只有通过核验的卡片会返回。补救沿用当前项目范围。只有显式请求归档时，补救才纳入归档候选。补救不会再次访问历史，也不会修改热点注入的匹配规则。已有严格结果时，`memory_search` 直接返回，补救不会增加模型调用。

模型最多调用两次，分别用于改写和候选核验。工具输出会说明补救是否找到了相关卡片，还是未能完成。完成补救但仍为空时，`memory_resolve` 可以继续查找更广的证据。

## 写入时保留用户用词

生成记忆正文时，模型可以从用户原问题和明确标记的用户证据里摘取最多四个称呼。保存流程只接受能在这些原文中找到的称呼，并把它们写入现有关键词索引。合并时保留旧关键词，只在总数低于八个时补入新词。已保存的记忆在下一次形成或合并时才会获得新称呼。

## 什么时候仍会搜不到

- 如果现有记忆和改写查询都没有词汇交集，候选池可能为空。
- 通用词可能把正确卡片挤出 BM25 候选页。模型也可能误判语义，或者在预算内无法完成。
- 严格搜索已找到一部分卡片时，补救不会检查复合问题还缺哪些卡片。后续分页也只用严格匹配。
- 用户没有明确提供某个别名，或现有关键词已满时，形成流程可能不会写入该别名。

## Issue #3 验证记录

基线使用 `b8bb659`，两组在线运行均使用 Pi 1.5.2 和 `auto/deepseek-v4.1-flash`。

- 99 条离线用例中，完整命中从 50 增至 51，回归为 0。安静率为 38/42，注入命中率为 0.909，既有的误注入为 4，两组相同。
- 14 个场景各重复 3 次。原用例的“名字”和“访问记录”可以指卡片未覆盖的属性，旧评分只检查回答中是否提到预期字样。重新运行这两项后，使用它们及原来其余 12 项汇总。应召回题从 25/27 提高到 27/27，检索失败从 2 降到 0。中文冷查询中，容器镜像的标签规则从 2/3 到 3/3，应用日志保留期两组均为 3/3。两项英文问法也各得 3/3。
- 原问题另做了一次 42 轮成本对照。用 Pi 模型目录费率折算网关的实际 token 用量，包含 Pi 和 daemon 的显式检索调用。总成本从 $0.05176 增至 $0.06313，每个按原评分命中的回答从 $0.002353 到 $0.002338。差幅约 0.6%，一次对照不足以判断稳定趋势。这次成本估算使用原题及原评分，应连同它们的歧义一起解读。

本地留档见 `eval/memory/out/issue-3/`。`trigger-corrected-*.json` 收录更正问法后的汇总，`trigger-priced-*.json` 和 `pricing.json` 收录成本对照。`shadow-*.json` 收录决策日志汇总。旧扩展只记录注入状态，旧报告中的工具调用数和注入预算字段缺少基线观测。

## 评测命令

在仓库根目录安装依赖，然后在 `eval/memory` 执行。离线候选评测使用当前环境的 `VESTIGIO_MODEL_BASE_URL`、`VESTIGIO_MODEL_ID` 和可选网关凭据。在线评测默认使用本地模型网关。基线在线评测可用 `--extension` 指向安装过依赖的基线 checkout，沿用相同模型设置。

```sh
cd eval/memory
node --import ../pi/hook.mjs ./run.mjs --out out/issue3-baseline.json
node --import ../pi/hook.mjs ./run.mjs --search-recovery --out out/issue3-offline.json
node ./compare.mjs out/issue3-baseline.json out/issue3-offline.json
node --import ../pi/hook.mjs ./trigger.mjs --repeats 3 --decision-log out/issue3-decisions.jsonl --out out/trigger-issue3.json
node ./shadow.mjs --log out/issue3-decisions.jsonl --out out/shadow-issue3.json
```

`trigger.mjs` 包含 Pi 报价和已计价的 daemon 检索调用。`unpriced_retrievals` 大于零时，`cost_per_hit_usd` 只反映已计价部分。比较时同时查看未计价次数、`retrieval_miss`、`trigger_miss` 和两项冷查询的逐轮结果。
