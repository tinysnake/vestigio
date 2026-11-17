#!/usr/bin/env bash
# Reproduce every Obelisk probe finding. Writes raw evidence under
# ./evidence/. Never opens the operator's real ~/.obelisk DB: every Obelisk
# invocation runs with HOME pointed at /tmp/obelisk-probe/*.
#
# Usage: ./run_all.sh [repeats]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPEATS="${1:-5}"
EV="$HERE/evidence"
WORK=/tmp/obelisk-probe
mkdir -p "$EV"
rm -rf "$WORK"
mkdir -p "$WORK"

# --- 1. capability matrix on installed 0.3.0 ------------------------------
"$HERE/make_fixture.sh" "$WORK/home" > "$EV/fixture-layout.txt"
HOME="$WORK/home" obelisk --version > "$EV/obelisk-version.txt" 2>&1
HOME="$WORK/home" obelisk --build >> "$EV/obelisk-version.txt" 2>&1
HOME="$WORK/home" obelisk --query "$HERE/queries.mjs" > "$EV/queries-030.json" 2> "$EV/queries-030.err"
echo "queries-030.json: $(wc -c < "$EV/queries-030.json") bytes, stderr $(wc -c < "$EV/queries-030.err") bytes"

# --- 2. uuid stability across rebuild / move / rename / edit ---------------
"$HERE/uuid_stability.sh" "$EV/uuid-stability" > "$EV/uuid-stability.txt" 2>&1

# --- 3. baselines ---------------------------------------------------------
python3 "$HERE/baselines.py" "$EV/baselines" "$REPEATS" > "$EV/baselines.txt" 2>&1

# --- 4. writer-lease behaviour -------------------------------------------
LOCK="$WORK/base-home/.obelisk/writer.lock.sqlite"
DB="$WORK/base-home/.obelisk/obelisk.sqlite"
{
  echo "# A cold --search (refresh would run) with the writer lease already held."
  node --input-type=module -e "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=0');db.exec('BEGIN IMMEDIATE');console.log('lock held');setTimeout(()=>{db.close();console.log('lock released')},3000);" "$LOCK" &
  HOLDER=$!
  sleep 0.8
  node --input-type=module -e "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec(\"DELETE FROM index_state WHERE jsonl_path='__last_build__'\");db.close();" "$DB"
  START=$(python3 -c "import time;print(time.perf_counter())")
  set +e
  HOME="$WORK/base-home" obelisk --search zqleak > "$EV/lock-search.out" 2> "$EV/lock-search.err"
  RC=$?
  set -e
  END=$(python3 -c "import time;print(time.perf_counter())")
  python3 -c "print('search_wall_s=%.3f exit=%s stdout_bytes=%d' % ($END-$START, $RC, __import__('os').path.getsize('$EV/lock-search.out')))"
  wait $HOLDER
  echo "stderr: $(cat "$EV/lock-search.err")"
} > "$EV/lock-test.txt" 2>&1

# --- 5. does a newer published release honour the advertised options? -----
{
  echo "# npm dist-tags / versions"
  npm view @obelisk-apps/cli dist-tags --json
  npm view @obelisk-apps/cli versions --json | tail -6
  echo
  echo "# GitHub release tags (API)"
  curl -sS -m 30 https://api.github.com/repos/tommy0103/obelisk/tags | grep '"name"'
  echo
  echo "# api-reference.md on main advertises:"
  curl -sS -m 30 "https://raw.githubusercontent.com/tommy0103/obelisk/main/skill-doc/references/api-reference.md" \
    | grep -nE 'snippetTokens|contextLimit|projectPath' | head
} > "$EV/upstream.txt" 2>&1

# pull 0.3.2 and check the options against the same fixture
rm -rf "$WORK/new" && mkdir -p "$WORK/new" && ( cd "$WORK/new"
  npm pack @obelisk-apps/cli@0.3.1 >/dev/null 2>&1 && tar xzf obelisk-apps-cli-0.3.1.tgz && mv package pkg-0.3.1
  npm pack @obelisk-apps/cli@0.3.2 >/dev/null 2>&1 && tar xzf obelisk-apps-cli-0.3.2.tgz && mv package pkg-0.3.2
)
{
  for v in 0.3.1 0.3.2; do
    echo "# $v: option names present in dist/query.js?"
    grep -c "projectPath\|snippetTokens\|contextLimit" "$WORK/new/pkg-$v/dist/core/src/query.js" || true
  done
  echo "# 0.3.1 dist search() option destructure:"
  grep -n "const { limit = 20" "$WORK/new/pkg-0.3.1/dist/core/src/query.js"
  echo "# 0.3.2 dist search() option destructure:"
  grep -n "const { limit = 20" "$WORK/new/pkg-0.3.2/dist/core/src/query.js"
} > "$EV/newer-release-options.txt" 2>&1

cat > "$WORK/verify032.mjs" <<'EOF'
const out={};
out.projectPath_A = search("zqleak",{projectPath:"/tmp/x_a"}).map(r=>r.session.project);
out.projectPath_B = search("zqleak",{projectPath:"/tmp/x-a"}).map(r=>r.session.project);
out.contextLimit_0 = search("zqleak",{contextLimit:0}).map(r=>r.context.length);
out.contextLimit_default = search("zqleak",{}).map(r=>r.context.length);
out.snippetTokens_4 = search("zqleak",{snippetTokens:4}).map(r=>({text:r.message.text,isSnippet:r.message.isSnippet,textLength:r.message.textLength}));
let e=null; try{search("zqleak",{contextLimit:7})}catch(err){e=String(err.message)}
out.contextLimit_7_threw=e;
return out;
EOF
HOME="$WORK/home" node "$WORK/new/pkg-0.3.2/dist/cli/src/obelisk.js" --version > "$EV/verify-032-version.txt"
HOME="$WORK/home" node "$WORK/new/pkg-0.3.2/dist/cli/src/obelisk.js" --build >/dev/null 2>&1
HOME="$WORK/home" node "$WORK/new/pkg-0.3.2/dist/cli/src/obelisk.js" --query "$WORK/verify032.mjs" > "$EV/verify-032.json" 2> "$EV/verify-032.err"

echo "all evidence in $EV"
ls -1 "$EV"
