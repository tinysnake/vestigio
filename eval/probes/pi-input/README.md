# pi-input probe harness

Throwaway probe that answers whether a pi extension can append text to the END of a user
input. Findings: `../../../../docs/probes/pi-input-findings.md`.

## Layout

- `mock-server.mjs` — local OpenAI-completions endpoint; records every request body as JSONL.
  `node mock-server.mjs 8799 /tmp/vestigio-probe/requests.jsonl` (`MOCK_DELAY_MS` delays the
  response so a client can steer mid-stream).
- `agent/` — isolated pi config dir:
  - `models.json` points the `mock` provider at `http://127.0.0.1:8799/v1`.
  - `settings.json` sets `compaction.keepRecentTokens=1` so a tiny session can be compacted.
  - `extensions/append-summary.ts` — the probe: an `input` handler that appends a marker,
    plus `/probe-ext-send` which emits an extension-source user message.
  - `prompts/probe.md`, `prompts/probe2.md`, `skills/probe-skill/SKILL.md` — expansion fixtures.
- `env.sh` — exports `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` and a `pi_probe` helper.
- `rpc_driver.py <prompt|steer|followup|extsend|compact>` — RPC-mode driver.
- `pty_driver.py "text"` — drives the real interactive TUI through a PTY.
- `inspect_requests.py [log] [--system]` — prints role + text of each captured request.
- `evidence/` — raw captures and session JSONL copies.

## Reproduce

```sh
node mock-server.mjs 8799 /tmp/vestigio-probe/requests.jsonl &
cd /tmp/vestigio-probe/cwd
python3 ../<probe>/rpc_driver.py prompt
```

Everything runs against a /tmp scratch dir; the operator's real pi state is never touched.
