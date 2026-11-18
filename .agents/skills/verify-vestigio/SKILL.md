---
name: verify-vestigio
description: Verify Vestigio pi extension lifecycle, memory delivery and stale updates through the real pi binary and isolated mock-provider harness.
---

# Verify Vestigio

## Launch

Run `pnpm install --frozen-lockfile` from the checkout root. The short-lived harness starts its own loopback provider and real pi RPC process. Run it serially; `eval/pi/run.mjs` owns `/tmp/vestigio-pi` and port 8799. Never run two copies concurrently.

## Doctor

Run `pi --version` and `pnpm -r typecheck`. Inspect `eval/pi/agent/models.json` to confirm the provider is loopback. `VESTIGIO_OBELISK_HOME` must point at the empty harness home, never the real user home.

## Drive

From `eval/pi`, run `node --import ./hook.mjs ./run.mjs --only new_session` for memory delivery, or `node --import ./hook.mjs ./run.mjs` for all mapped scenarios. The exact filter is `new_session`; `--dump new-session` uses a different name. An unknown filter can otherwise execute no feature assertions. See `features/README.md` for stale scenarios as they are added.

## Evidence

Capture stdout/stderr and exit status to a unique directory outside `/tmp/vestigio-pi`, such as `/tmp/vestigio-proof-<run-id>`. A pass requires the requested scenario assertions to appear, not merely `ALL CHECKS PASSED`. The harness captures actual provider request bodies and pi decision logs. Inspect stored pending events/revisions for stale transitions and acknowledgement. Unit tests alone do not establish lifecycle delivery. Mocking the external model provider is allowed; do not replace pi hooks or the extension with a mock.

## Cleanup

The harness closes its mock server and the pi children it started. Confirm its command exited. Do not kill by process name or remove the proof directory. Scratch stores/logs under `/tmp/vestigio-pi` remain available and are reset by the next run. The harness checks the real Obelisk index mtime before and after without opening it.
