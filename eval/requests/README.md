# Proactive request free-choice eval

This eval asks a real coding model, in ordinary language, to save, correct, or
ignore a memory. It does not script tool calls and does not mock the provider:
the model decides whether `memory_request_write`, `memory_mark_stale`, a search,
or no action is the right response. The assertions score that choice against the
fixed cases in `cases.jsonl`.

It runs the real `pi` binary with only this checkout's Vestigio extension and a
memory-tool allowlist. Every store, session, decision log, and Obelisk home lives
under `/tmp/vestigio-requests`; the operator's real Obelisk index is checked
before and after and must not change. Authentication is copied from
`~/.pi/agent` into the isolated agent home only for the run and deleted at the
end unless `--keep` is passed.

## Run

```sh
cd eval/requests
node --import ../pi/hook.mjs ./run.mjs --dry-run
node --import ../pi/hook.mjs ./run.mjs
node --import ../pi/hook.mjs ./run.mjs --only overlap-explicit-save
node --import ../pi/hook.mjs ./run.mjs --repeat 3 --keep
```

Defaults match the live harness: provider `magpie`, agent and extension model
`auto/deepseek-v4.1-flash`, thinking `low`. Override with `--provider`,
`--agent-model`, `--extension-model`, and `--thinking`. `PI_BIN` selects the pi
binary. The gateway and model must be reachable; the extension's summary call
uses `--extension-model`.

This costs real tokens: thirteen cases, one or two agent turns each (a case that
offers proactively gets a second operator-reply turn), plus extension-side
detector and summary calls. Nothing is run by the unit test suite or CI.

## Cases

| Case | Prompt intent | Expected |
| --- | --- | --- |
| `temporary-session-only` | "这次先记住…跳过测试" | no request, no memory |
| `explicit-scoped-save` | "记住：这个项目…使用 pnpm" | one saved project-scoped request in the same turn, with no question and no reply turn |
| `temporary-exception-vs-default` | "这次发布先只跑相关测试" | no request, stored default stays r1 with no pending event |
| `verified-stale` | "我刚验证过…端口现在是 18080" | no approved save; the change is recorded as stale or the seeded memory is repaired |
| `refusal` | "把刚才说的那条规则保存下来" with no prior statement | no request, no memory |
| `overlap-explicit-save` | "记住：部署脚本默认端口保持 18080" over an existing topic | one saved/merged request, one topic |
| `durable-this-incident` | "记住：这次端口排障的原因是…" | one saved memory; "this" does not make an incident conclusion session-only |
| `negated-save` | "不要记住这个：…" | no request, no memory |
| `durable-convention-proposal` | a durable convention with no save command | no row on the offer turn, an offer question in the reply, then the reply `好` saves one memory |
| `declined-proposal` | a durable convention, operator answers `不用` | no row on the offer turn, no request and no memory after the decline |
| `moved-on-proposal` | a durable convention, operator answers something unrelated | no row on the offer turn, no request and no memory after the unrelated reply |
| `proactive-accepted` | a durable convention with no save command | no row on the offer turn, then `好` saves one memory |
| `proactive-declined` | a durable convention, operator answers `不用` | no row on the offer turn, no request and no memory after the decline |

A judged-durable ask never opens a confirmation dialog and never writes on the
offer turn: the agent ends its reply with one short question, and only the
operator's own next message can make it call `memory_request_write`. Every case
requires that no `extension_ui_request` ever appeared. When a case expects a
proactive write (`"proactive": true`) the harness asserts zero rows after the
first turn, sends the case's `reply` (default `好`) as a new operator turn, and
only then scores the final rows and memory heads. A case whose expectation is
that nothing saves sets `"reply": null`, so the harness never manufactures an
agreement the model did not earn. `memory_request_status` rows that are merely
accepted/pending are never counted as saved.

Each repetition writes `runs/<case>-r<n>/record.json` with the prompt, reply
turns, tool calls, dialogs, request rows before and after the reply, memory
heads, pending stale events, and checks. A failed run keeps the record; inspect it
before rerunning.

## Reading a failure

- `request count` off in `temporary-*`: the model turned a session preference
  into a durable candidate, or the directive classifier failed to reject it.
- `saved requests` off in `explicit-*`: the model did not call
  `memory_request_write` in the same turn, the request stayed pending after a
  retry, or summary composition failed. `record.json` has the request reason and
  navigation state.
- `no request on the offer turn` off in a `proactive: true` case: the model wrote
  directly instead of offering, so the operator never got a choice.
- `saved requests` off in a `proactive: true` case: the model offered but then did
  not act on the operator's `好`, or the composed request failed.
- `operator reply turns` off: the harness sent a reply the case did not expect,
  usually because the model saved on the first turn.
- `verified change recorded as stale` off: the model saved a correction instead
  of marking the delivered revision stale. That is the bypass this case forbids.
- `one topic after overlap` off: the request created a second head instead of
  reusing/merging the existing subject.
