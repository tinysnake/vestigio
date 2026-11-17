# Source this to run the PR-05 harness pieces by hand.
#
#   . ./env.sh
#   node --import "$PI_EVAL_HOOK" "$PI_EVAL_DIR/seed.mjs" "$PI_EVAL_TMP/seed.sqlite" \
#     "$PI_EVAL_TMP/project" "$PI_EVAL_TMP/perf-project"
#   vestigio_pi --mode rpc --provider mock --model mock-1 \
#     --no-context-files --no-mcp --no-extensions \
#     -e "$VESTIGIO_ROOT/packages/pi-extension/src/extension.ts" \
#     --prompt-template "$PI_EVAL_DIR/prompts" --skill "$PI_EVAL_DIR/skills" \
#     --session-dir "$PI_EVAL_TMP/sessions/manual"
#
# The isolated agent dir keeps the operator's own extensions, settings and
# sessions out of the run; --no-extensions disables discovery entirely.

PI_EVAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VESTIGIO_ROOT="$(cd "$PI_EVAL_DIR/../.." && pwd)"
PI_EVAL_TMP="/tmp/vestigio-pi"
PI_EVAL_HOOK="$PI_EVAL_DIR/hook.mjs"

export PI_CODING_AGENT_DIR="$PI_EVAL_DIR/agent"
export PI_CODING_AGENT_SESSION_DIR="$PI_EVAL_TMP/sessions"
export PI_OFFLINE=1
export PI_SKIP_VERSION_CHECK=1

# The harness always points the extension at an isolated store and history home.
export VESTIGIO_STORE="$PI_EVAL_TMP/run.sqlite"
export VESTIGIO_PROJECT_ID="$PI_EVAL_TMP/project"
export VESTIGIO_OBELISK_HOME="$PI_EVAL_TMP/obelisk-home"
export VESTIGIO_DECISION_LOG="$PI_EVAL_TMP/decisions-manual.jsonl"

mkdir -p "$PI_EVAL_TMP/cwd" "$PI_EVAL_TMP/sessions" "$VESTIGIO_OBELISK_HOME"

vestigio_pi() {
	(cd "$PI_EVAL_TMP/cwd" && pi "$@")
}
