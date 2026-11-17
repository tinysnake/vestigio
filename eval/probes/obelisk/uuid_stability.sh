#!/usr/bin/env bash
# Does a message uuid survive (a) an index rebuild and (b) a move of the
# source file? Runs entirely inside an isolated HOME.
#
# Usage: uuid_stability.sh <evidence-dir>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EV="${1:?usage: uuid_stability.sh <evidence-dir>}"
HOME_DIR=/tmp/obelisk-probe/uuid-home
mkdir -p "$EV"

"$HERE/make_fixture.sh" "$HOME_DIR" >/dev/null
SESS="$HOME_DIR/.pi/agent/sessions"

run() { # run <label>
  HOME="$HOME_DIR" obelisk --query "$HERE/dump_uuids.mjs" > "$EV/$1.json"
  echo "wrote $EV/$1.json"
}

# 1. baseline build
HOME="$HOME_DIR" obelisk --build >/dev/null
run step1_build

# 2. index rebuild, same files
HOME="$HOME_DIR" obelisk --build >/dev/null
run step2_rebuild

# 3. move the source file to a different directory (same sessions root)
mkdir -p "$SESS/projC"
mv "$SESS/projA/sessA.jsonl" "$SESS/projC/sessA.jsonl"
HOME="$HOME_DIR" obelisk --build >/dev/null
run step3_moved_dir

# 4. rename the file in place
mv "$SESS/projC/sessA.jsonl" "$SESS/projC/sessA-renamed.jsonl"
HOME="$HOME_DIR" obelisk --build >/dev/null
run step4_renamed

# 5. edit: insert a new first entry, shifting every following ordinal
python3 - "$SESS/projB/sessB.jsonl" <<'PY'
import sys
p = sys.argv[1]
lines = open(p, encoding='utf-8').read().splitlines()
header, rest = lines[0], lines[1:]
inserted = '{"id":"c0","parentId":null,"type":"message","timestamp":"2026-01-01T00:00:59.000Z","message":{"role":"user","content":[{"type":"text","text":"zqleak beta prepended entry"}]}}'
# c1 now reparents to c0
rest = [l.replace('"id":"c1","parentId":null', '"id":"c1","parentId":"c0"') for l in rest]
open(p, 'w', encoding='utf-8').write('\n'.join([header, inserted, *rest]) + '\n')
PY
HOME="$HOME_DIR" obelisk --build >/dev/null
run step5_inserted

python3 - "$EV" <<'PY'
import json, sys, os
from collections import Counter
ev = sys.argv[1]
def load(step):
    d = json.load(open(os.path.join(ev, step + '.json')))
    s = {m['uuid']: m['text'] for m in d['messages']}
    paths = {x['id']: x['jsonl_path'] for x in d['sessions']}
    return s, paths
base, base_paths = load('step1_build')
for step in ['step2_rebuild', 'step3_moved_dir', 'step4_renamed', 'step5_inserted']:
    cur, cur_paths = load(step)
    same_uuid_set = set(base) == set(cur)
    text_changed = sorted(u for u in set(base) & set(cur) if base[u] != cur[u])
    lost = sorted(set(base) - set(cur))
    gained = sorted(set(cur) - set(base))
    print(f"{step}: uuid_set_identical={same_uuid_set} count={len(cur)} "
          f"same_uuid_new_text={len(text_changed)} lost={len(lost)} gained={len(gained)}")
    for u in text_changed[:3]:
        print(f"    {u.split(':')[1]} {u.split('entry:')[1][:6]}: {base[u][:40]!r} -> {cur[u][:40]!r}")
    print(f"    session paths: {cur_paths}")
PY
