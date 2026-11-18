# Session lifecycle

## Sub-features

Continue, compaction, prompt expansion, queued input, steering and handler failure.

## How to get to it (user POV)

Continue an existing pi conversation, compact it, or submit a follow-up or steering message while it works.

## Driving it with the pi harness

Run the full `node --import ./hook.mjs ./run.mjs` from `eval/pi`. Inspect the named `continue`, `compaction`, `queued`, `steer`, `prompt-template`, `skill-command` and `handler-error` checks and captured wire bodies.

## Gotchas

This is a single shared temporary harness instance. Run serially. Model output comes from the local mock provider.
