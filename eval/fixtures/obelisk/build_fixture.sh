#!/usr/bin/env bash
# Build an isolated Obelisk index for the source adapter's live tests.
#
# The transcript corpus comes from the probe's builder
# (eval/probes/obelisk/make_fixture.sh): two pi sessions in `cwd` "/tmp/x_a" and
# "/tmp/x-a" whose derived slugs differ only by one character, with an active
# a1->a2->a3 chain, an abandoned branch b1, an isMeta row m1, a hidden h1, and a
# shared search token. That is the corpus that makes the LIKE leak and the
# hidden/inactive rules observable.
#
# Everything the CLI touches is derived from $HOME, so the build runs with HOME
# set to the fixture directory. The operator's ~/.obelisk/obelisk.sqlite is
# never opened: there is no code path here that does not set HOME first.
#
# Usage:
#   eval/fixtures/obelisk/build_fixture.sh [home-dir]
# Env:
#   OBELISK_BIN   CLI entry (default: the pinned @obelisk-apps/cli in
#                 packages/source-obelisk/node_modules)
# Prints the fixture home and the manifest path on success.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HOME_DIR="${1:-$(mktemp -d "vestigio-obelisk--fixture.XXXXXX")}"
MANIFEST="$HOME_DIR/fixture-manifest.json"

ENTRY="${OBELISK_BIN:-$ROOT/packages/source-obelisk/node_modules/@obelisk-apps/cli/dist/cli/src/obelisk.js}"
if [ ! -f "$ENTRY" ]; then
  echo "no Obelisk CLI at $ENTRY; run 'pnpm install' in $ROOT or set OBELISK_BIN" >&2
  exit 2
fi
case "$ENTRY" in
  *.js) CLI=(node "$ENTRY") ;;
  *)    CLI=("$ENTRY") ;;
esac

# The builder rewrites $HOME_DIR wholesale, so this is a fresh corpus each run.
"$ROOT/eval/probes/obelisk/make_fixture.sh" "$HOME_DIR" >/dev/null

VERSION="$(HOME="$HOME_DIR" "${CLI[@]}" --version)"
INDEX="$HOME_DIR/.obelisk/obelisk.sqlite"

STARTED="$(python3 -c 'import time; print(time.monotonic())')"
BUILD="$(HOME="$HOME_DIR" "${CLI[@]}" --build)"
BUILD_MS="$(python3 -c "import time; print(round((time.monotonic() - $STARTED) * 1000))")"

[ -f "$INDEX" ] || { echo "build reported $BUILD but $INDEX is missing" >&2; exit 1; }

# Warm one search so the live tests measure the adapter, not the first refresh.
HOME="$HOME_DIR" "${CLI[@]}" --search zqleak --limit 20 --project-path /tmp/x_a --context-limit 0 >/dev/null

SCOPED_A="$(HOME="$HOME_DIR" "${CLI[@]}" --search zqleak --limit 20 --project-path /tmp/x_a --context-limit 0)"
SCOPED_B="$(HOME="$HOME_DIR" "${CLI[@]}" --search zqleak --limit 20 --project-path /tmp/x-a --context-limit 0)"
# The adapter never exposes `project` (SQL LIKE). This script proves why: the
# same corpus and token, filtered by the literal slug `-tmp-x_a`, returns B too.
LEAK_STARTED="$(python3 -c 'import time; print(time.monotonic())')"
LIKE_LEAK="$(HOME="$HOME_DIR" "${CLI[@]}" --query "$ROOT/eval/fixtures/obelisk/like_leak.query.mjs")"
LEAK_MS="$(python3 -c "import time; print(round((time.monotonic() - $LEAK_STARTED) * 1000))")"

python3 - "$MANIFEST" "$HOME_DIR" "$INDEX" "$ENTRY" "$VERSION" "$BUILD_MS" "$LEAK_MS" \
  "$SCOPED_A" "$SCOPED_B" "$LIKE_LEAK" <<'PY'
import json, os, sys

manifest, home, index, entry, version, build_ms, leak_ms, a_raw, b_raw, leak_raw = sys.argv[1:11]
a = json.loads(a_raw)
b = json.loads(b_raw)
leak = json.loads(leak_raw)


def hits(rows):
    return [
        {
            "uuid": row["message"]["uuid"],
            "project": row["session"]["project"],
            "role": row["message"]["role"],
            "text": row["message"]["text"],
        }
        for row in rows
    ]


data = {
    "schema": "vestigio.obelisk-fixture/1",
    "home": home,
    "index": index,
    "index_bytes": os.path.getsize(index),
    "cli_entry": entry,
    "cli_version": version,
    "build_ms": int(build_ms),
    "like_query_ms": int(leak_ms),
    "corpus": {
        "sessions": {"sessA": "/tmp/x_a", "sessB": "/tmp/x-a"},
        "token": "zqleak",
        "active_chain": ["a1", "a2", "a3"],
        "inactive_branch": "b1",
        "meta_row": "m1",
        "hidden_row": "h1",
    },
    "observed": {
        "exact_project_x_a": hits(a),
        "exact_project_x_a_count": len(a),
        "exact_project_x_a_slugs": sorted({row["session"]["project"] for row in a}),
        "exact_project_x_dash_a": hits(b),
        "like_leak_count": len(leak),
        "like_leak_projects": sorted({row["project"] for row in leak}),
    },
}
with open(manifest, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, sort_keys=True)
    fh.write("\n")

assert data["observed"]["exact_project_x_a_count"] == 3, data["observed"]
assert data["observed"]["exact_project_x_a_slugs"] == ["-tmp-x_a"], data["observed"]
assert len(b) == 1, data["observed"]
assert data["observed"]["like_leak_projects"] == ["-tmp-x-a", "-tmp-x_a"], data["observed"]

print(json.dumps({
    "home": home,
    "index": index,
    "index_bytes": data["index_bytes"],
    "cli_version": version,
    "build_ms": data["build_ms"],
    "like_query_ms": data["like_query_ms"],
    "exact_project_x_a": data["observed"]["exact_project_x_a_count"],
    "exact_project_x_dash_a": len(b),
    "like_leak_count": data["observed"]["like_leak_count"],
    "like_leak_projects": data["observed"]["like_leak_projects"],
}, indent=2))
PY

echo "fixture home: $HOME_DIR"
echo "manifest:     $MANIFEST"
