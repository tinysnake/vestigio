#!/usr/bin/env bash
# Live proof for the storage store: real processes, real SQLite files, no mocks.
set -euo pipefail
cd "$(dirname "$0")"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vestigio-live-XXXXXX")"
CONCURRENT_DB="$RUN_DIR/concurrent.db"
CRASH_DB="$RUN_DIR/crash.db"
CRASH_MARKER="$RUN_DIR/crash.marker"
set -x

echo "run dir: $RUN_DIR"

# --- concurrent writers and readers on one database file -------------------
node --import ./hook.mjs worker-writer.ts "$CONCURRENT_DB" 1 400 >"$RUN_DIR/w1.log" 2>&1 &
W1=$!
node --import ./hook.mjs worker-writer.ts "$CONCURRENT_DB" 2 400 >"$RUN_DIR/w2.log" 2>&1 &
W2=$!
node --import ./hook.mjs worker-writer.ts "$CONCURRENT_DB" 3 400 >"$RUN_DIR/w3.log" 2>&1 &
W3=$!
node --import ./hook.mjs worker-writer.ts "$CONCURRENT_DB" 4 400 >"$RUN_DIR/w4.log" 2>&1 &
W4=$!

node --import ./hook.mjs worker-reader.ts "$CONCURRENT_DB" 3000 >"$RUN_DIR/r1.log" 2>&1 &
R1=$!
node --import ./hook.mjs worker-reader.ts "$CONCURRENT_DB" 3000 >"$RUN_DIR/r2.log" 2>&1 &
R2=$!

wait "$W1" "$W2" "$W3" "$W4"
wait "$R1" "$R2"

cat "$RUN_DIR"/w1.log "$RUN_DIR"/w2.log "$RUN_DIR"/w3.log "$RUN_DIR"/w4.log
cat "$RUN_DIR"/r1.log "$RUN_DIR"/r2.log

node --import ./hook.mjs verify.ts "$CONCURRENT_DB"

# --- a writer killed in the middle of a revision write ---------------------
rm -f "$CRASH_MARKER"
node --import ./hook.mjs crash-writer.ts "$CRASH_DB" "$CRASH_MARKER" >"$RUN_DIR/crash.log" 2>&1 &
CRASH=$!
for _ in $(seq 1 400); do
  if [ -f "$CRASH_MARKER" ]; then
    break
  fi
  sleep 0.05
done
cat "$RUN_DIR/crash.log"
kill -9 "$CRASH"
wait "$CRASH" || true
echo "killed pid $CRASH with SIGKILL mid-transaction"
ls -l "$CRASH_DB" "$CRASH_DB-wal" "$CRASH_DB-shm" || true

node --import ./hook.mjs verify-crash.ts "$CRASH_DB"

# --- fixed synthetic corpus: read, write and lock-wait latency -------------
CORPUS=2000 READS=500 WRITES=200 LOCK_ROUNDS=20 \
  node --import ./hook.mjs bench.ts
