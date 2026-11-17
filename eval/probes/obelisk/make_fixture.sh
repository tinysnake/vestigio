#!/usr/bin/env bash
# Build an isolated Obelisk fixture HOME.
#
# Obelisk resolves ~/.obelisk/obelisk.sqlite and every provider root from
# os.homedir(), which honours $HOME on POSIX. Pointing HOME at a throwaway
# directory therefore isolates the probe completely: no real ~/.obelisk DB is
# opened and no real transcript root is read.
#
# Usage: make_fixture.sh <home-dir>
set -euo pipefail

HOME_DIR="${1:?usage: make_fixture.sh <home-dir>}"
SESS="$HOME_DIR/.pi/agent/sessions"
rm -rf "$HOME_DIR"
mkdir -p "$SESS/projA" "$SESS/projB"

# Session A: cwd /tmp/x_a (project slug -tmp-x_a).
# Active chain a1 -> a2 -> a3 (the `leaf` entry pins head to a3).
#   b1  branches off a2, so it is NOT on the active path  -> inactive
#   m1  isMeta:true on the active chain                     -> is_meta row
#   h1  custom_message with display:false                   -> hidden
cat > "$SESS/projA/sessA.jsonl" <<'JSONL'
{"type":"session","version":3,"id":"sessA","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/x_a"}
{"id":"a1","parentId":null,"type":"message","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"zqleak alpha first user message"}]}}
{"id":"a2","parentId":"a1","type":"message","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"zqleak alpha first assistant reply"}],"model":"probe-model"}}
{"id":"a3","parentId":"a2","type":"message","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"user","content":[{"type":"text","text":"zqleak alpha second user message"}]}}
{"id":"b1","parentId":"a2","type":"message","timestamp":"2026-01-01T00:00:04.000Z","message":{"role":"assistant","content":[{"type":"text","text":"zqleak alpha abandoned branch message"}],"model":"probe-model"}}
{"id":"m1","parentId":"a3","type":"custom_message","timestamp":"2026-01-01T00:00:05.000Z","content":"zqleak alpha meta envelope"}
{"id":"h1","parentId":"m1","type":"custom_message","timestamp":"2026-01-01T00:00:06.000Z","display":false,"content":"zqleak alpha hidden marker"}
{"id":"leafA","parentId":"h1","type":"leaf","timestamp":"2026-01-01T00:00:07.000Z","targetId":"m1"}
JSONL

# Session B: cwd /tmp/x-a. Its slug (-tmp-x-a) differs from A's (-tmp-x_a) by
# one character. A SQL LIKE on the literal A slug treats `_` as a single-char
# wildcard, so it also matches B -- the concrete cross-project leak.
cat > "$SESS/projB/sessB.jsonl" <<'JSONL'
{"type":"session","version":3,"id":"sessB","timestamp":"2026-01-01T00:01:00.000Z","cwd":"/tmp/x-a"}
{"id":"c1","parentId":null,"type":"message","timestamp":"2026-01-01T00:01:01.000Z","message":{"role":"user","content":[{"type":"text","text":"zqleak beta message in another project"}]}}
JSONL

echo "fixture home: $HOME_DIR"

# Optional large synthetic corpus: EXTRA_SESSIONS sessions x MSGS_PER_SESSION
# messages, used to make the pre-query refresh cost visible. Default 0.
EXTRA="${EXTRA_SESSIONS:-0}"
MSGS="${MSGS_PER_SESSION:-50}"
if [ "$EXTRA" -gt 0 ]; then
  python3 - "$SESS/projBig" "$EXTRA" "$MSGS" <<'PY'
import os, sys
outdir, extra, msgs = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
os.makedirs(outdir, exist_ok=True)
for i in range(1, extra + 1):
    lines = ['{"type":"session","version":3,"id":"big%d","timestamp":"2026-02-01T00:00:00.000Z","cwd":"/tmp/big-%d"}' % (i, i)]
    for j in range(1, msgs + 1):
        parent = 'null' if j == 1 else '"big%d-e%d"' % (i, j - 1)
        ts = "2026-02-01T%02d:%02d:%02d.000Z" % (j // 3600, (j // 60) % 60, j % 60)
        text = "zqleak bignoise session %d message %d filler text" % (i, j)
        lines.append('{"id":"big%d-e%d","parentId":%s,"type":"message","timestamp":"%s","message":{"role":"user","content":[{"type":"text","text":"%s"}]}}' % (i, j, parent, ts, text))
    with open(os.path.join(outdir, "big-%d.jsonl" % i), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
PY
fi

find "$HOME_DIR" -type f | sort
