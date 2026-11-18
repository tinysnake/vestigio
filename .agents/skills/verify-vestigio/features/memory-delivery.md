# Memory delivery

## Sub-features

Hotspot matching, bounded appended notes, project scope and same-session dedup.

## How to get to it (user POV)

Start pi with a configured Vestigio store and ask about a known memory topic.

## Driving it with the pi harness

Run `node --import ./hook.mjs ./run.mjs --only new_session` from `eval/pi`. Confirm the named `new_session` checks ran. The first request contains one note and a `memory_read` URI. A repeated request contains no duplicate note. Other project content stays absent.

## Gotchas

The filter uses an underscore. `--dump new-session` uses a hyphen. Do not treat a run without feature assertions as proof.
