#!/usr/bin/env bash
# Shared environment for the pi-input probes. Source this file.
P=/Users/snake/workspace/vestigio/eval/probes/pi-input
export PI_CODING_AGENT_DIR=$P/agent
export PI_CODING_AGENT_SESSION_DIR=/tmp/vestigio-probe/sessions
export PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1
export PROBE_EVENTS=/tmp/vestigio-probe/events.jsonl
export MOCK_LOG=/tmp/vestigio-probe/requests.jsonl
export PROBE_ROOT=$P
mkdir -p /tmp/vestigio-probe/cwd /tmp/vestigio-probe/sessions
pi_probe() {
  ( cd /tmp/vestigio-probe/cwd && pi "$@" )
}
