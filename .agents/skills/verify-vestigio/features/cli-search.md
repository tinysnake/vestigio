# CLI search and read

## Sub-features

Layered `search` over a store (active cards, `--archived`, `--history`), `read` by `memory://` URI, and machine-readable `--json` output.

## How to get to it (user POV)

An operator inspects what vestigio would recall for a question, then opens the card behind a URI.

## Driving it with the CLI

From the checkout root:

```
T=$(mktemp -d /tmp/vestigio-cli-XXXX)
node --import ./eval/pi/hook.mjs eval/pi/seed.mjs "$T/store.sqlite" "$PWD" "$T/perf-project"
./packages/cli/bin/vestigio search --db "$T/store.sqlite" --project "$PWD" --query "部署 端口" --json
./packages/cli/bin/vestigio read --db "$T/store.sqlite" --uri memory://vestigio/mem-deploy-port --json
```

On Windows `./packages/cli/bin/vestigio` is not runnable; use `node --import ./packages/cli/hook.mjs packages/cli/src/entry.ts` in its place, or the `vestigio.cmd` shim `deploy.mjs` wrote.

A pass shows `"status": "partial"` with `memory_id: "mem-deploy-port"` in the search, and `"status": "resolved"` with a body in the read. Save both stdout bodies as the proof.

## Gotchas

`packages/cli/bin/vestigio` is a bash wrapper, so execute it directly; `node packages/cli/bin/vestigio` fails with `SyntaxError: Invalid or unexpected token`. On Windows it does not run at all; use `node --import ./packages/cli/hook.mjs packages/cli/src/entry.ts` instead. `--project` must be the absolute path used when the memory was written, otherwise the card is scoped out. `seed.mjs` only runs with `--import ./eval/pi/hook.mjs` to map the repo's `.js` specifiers to `.ts`. A search against a missing `--db` path creates that store.
