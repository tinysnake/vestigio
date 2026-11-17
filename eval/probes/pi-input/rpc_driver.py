#!/usr/bin/env python3
"""Minimal RPC driver for the pi-input probes.

Usage: python3 rpc_driver.py <scenario>
Scenarios: prompt | steer | followup | extsend | compact | compactauto
Prints all events as they arrive (stderr) and captured wire requests at the end.
"""
import json
import os
import subprocess
import sys
import threading
import time

P = "/Users/snake/workspace/vestigio/eval/probes/pi-input"
EXT = f"{P}/agent/extensions/append-summary.ts"
SCEN = sys.argv[1] if len(sys.argv) > 1 else "prompt"

env = dict(os.environ)
env["PI_CODING_AGENT_DIR"] = f"{P}/agent"
env["PI_CODING_AGENT_SESSION_DIR"] = f"/tmp/vestigio-probe/sessions/{SCEN}"
env["PI_OFFLINE"] = "1"
env["PI_SKIP_VERSION_CHECK"] = "1"
env["PROBE_EVENTS"] = f"/tmp/vestigio-probe/events-{SCEN}.jsonl"
env["MOCK_LOG"] = f"/tmp/vestigio-probe/requests.jsonl"
os.makedirs(env["PI_CODING_AGENT_SESSION_DIR"], exist_ok=True)
for f in (env["PROBE_EVENTS"], env["MOCK_LOG"]):
    open(f, "w").close()

cmd = [
    "pi", "--mode", "rpc",
    "--provider", "mock", "--model", "mock-1",
    "--no-context-files", "--no-mcp", "--no-extensions",
    "-e", EXT,
    "--prompt-template", f"{P}/agent/prompts",
    "--skill", f"{P}/agent/skills",
    "--session-dir", env["PI_CODING_AGENT_SESSION_DIR"],
]
proc = subprocess.Popen(
    cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, bufsize=1, cwd="/tmp/vestigio-probe/cwd", env=env,
)

events = []
lock = threading.Lock()


def reader():
    for line in proc.stdout:
        try:
            rec = json.loads(line)
        except Exception:
            continue
        with lock:
            events.append(rec)
        if rec.get("type") in ("agent_settled", "agent_end", "compaction_end", "error"):
            print("EV:", json.dumps(rec)[:300], file=sys.stderr)


threading.Thread(target=reader, daemon=True).start()


def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def wait_for(pred, timeout=30.0):
    end = time.time() + timeout
    while time.time() < end:
        with lock:
            for e in events:
                if pred(e):
                    return e
        time.sleep(0.1)
    return None


def wait_settle(timeout=30.0):
    return wait_for(lambda e: e.get("type") == "agent_settled", timeout)


def prompt(msg, cid):
    send({"id": cid, "type": "prompt", "message": msg})


if SCEN == "prompt":
    prompt("RPC_PROMPT hello", "1")
    wait_settle()
elif SCEN == "steer":
    prompt("RPC_STEER_BASE", "1")
    wait_for(lambda e: e.get("type") == "message_start", 10)
    time.sleep(0.3)
    send({"id": "2", "type": "steer", "message": "RPC_STEER_TEXT"})
    wait_settle()
    time.sleep(0.5)
elif SCEN == "followup":
    prompt("RPC_FOLLOWUP_BASE", "1")
    time.sleep(0.3)
    send({"id": "2", "type": "follow_up", "message": "RPC_FOLLOWUP_TEXT"})
    wait_settle()
    time.sleep(0.5)
elif SCEN == "extsend":
    prompt("/probe-ext-send RPC_EXT_HELLO", "1")
    wait_settle()
    time.sleep(1.0)
    wait_settle(5)
elif SCEN in ("compact", "compactauto"):
    prompt("COMPACT_ONE", "1")
    wait_settle()
    time.sleep(0.3)
    prompt("COMPACT_TWO", "2")
    wait_settle()
    time.sleep(0.3)
    if SCEN == "compact":
        send({"id": "3", "type": "compact", "customInstructions": "Keep the marker."})
        wait_for(lambda e: e.get("type") in ("compaction_end", "response") and e.get("command") == "compact", 60)
        time.sleep(0.5)
    prompt("COMPACT_POST three", "4")
    wait_settle()

time.sleep(0.5)
try:
    proc.stdin.close()
except Exception:
    pass
time.sleep(0.5)
proc.terminate()
try:
    proc.wait(timeout=5)
except Exception:
    proc.kill()

print("\n===== WIRE REQUESTS =====")
with open(env["MOCK_LOG"]) as f:
    for line in f:
        e = json.loads(line)
        b = e.get("body") or {}
        print(f"--- {e['ts']} model={b.get('model')}")
        for m in b.get("messages", []):
            c = m.get("content")
            txt = c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)
            tag = ""
            if m.get("role") == "user" and "VESTIGIO_PROBE_MARKER" in txt:
                tag = "  <<< MARKER PRESENT"
            print(f"  [{m.get('role')}] {txt[:600]}{tag}")
print("\n===== INPUT EVENTS =====")
try:
    with open(env["PROBE_EVENTS"]) as f:
        print(f.read())
except FileNotFoundError:
    print("(none)")
