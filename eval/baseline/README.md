# eval/baseline

PR-01 baseline harness. It answers one question twice and writes a resource
ledger:

- `none` — no memory at all; delivers nothing and reads 0 bytes.
- `obelisk` — shells out to `obelisk --search <question>` and records the bytes
  and an estimated token count of the returned payload.

Run:

```sh
node eval/baseline/run.mjs --question "记得之前定过记忆层用哪个 SQLite 驱动吗"
```

Output goes to `eval/baseline/out/latest.json`, a timestamped copy, and stdout.
When Obelisk is missing or exits non-zero the run is recorded as `not_run` with
a reason and `null` resource numbers — the harness never invents a measurement.

`token_estimate = ceil(bytes / 4)`. It is a heuristic, not a tokenizer count.
