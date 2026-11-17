#!/usr/bin/env python3
"""Drive the real interactive TUI through a PTY and type a message.

Usage: python3 pty_driver.py "text to type"
"""
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time

P = "/Users/snake/workspace/vestigio/eval/probes/pi-input"
text = sys.argv[1] if len(sys.argv) > 1 else "PTY_TYPED hello"

env = dict(os.environ)
env["PI_CODING_AGENT_DIR"] = f"{P}/agent"
env["PI_CODING_AGENT_SESSION_DIR"] = "/tmp/vestigio-probe/sessions/pty"
env["PI_OFFLINE"] = "1"
env["PI_SKIP_VERSION_CHECK"] = "1"
env["PROBE_EVENTS"] = "/tmp/vestigio-probe/events-pty.jsonl"
env["MOCK_LOG"] = "/tmp/vestigio-probe/requests.jsonl"
env["TERM"] = "xterm-256color"
os.makedirs(env["PI_CODING_AGENT_SESSION_DIR"], exist_ok=True)
for f in (env["PROBE_EVENTS"], env["MOCK_LOG"]):
    open(f, "w").close()

cmd = [
    "pi",
    "--provider", "mock", "--model", "mock-1",
    "--no-context-files", "--no-mcp", "--no-extensions",
    "-e", f"{P}/agent/extensions/append-summary.ts",
    "--prompt-template", f"{P}/agent/prompts",
    "--skill", f"{P}/agent/skills",
    "--session-dir", env["PI_CODING_AGENT_SESSION_DIR"],
]

master, slave = pty.openpty()
# 200 cols x 50 rows
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))

proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env,
                        cwd="/tmp/vestigio-probe/cwd", start_new_session=True)
os.close(slave)

out = []


def drain(t):
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.2)
        if master in r:
            try:
                data = os.read(master, 65536)
            except OSError:
                return
            if not data:
                return
            out.append(data.decode("utf-8", "replace"))


drain(5)  # startup
os.write(master, (text + "\r").encode())
drain(7)  # model delay is 3000ms
os.write(master, b"\x03")  # Ctrl+C
drain(1)
os.write(master, b"\x03")
drain(1)
proc.terminate()
try:
    proc.wait(timeout=5)
except Exception:
    proc.kill()

with open("/tmp/vestigio-probe/pty-transcript.txt", "w") as f:
    f.write("".join(out))
print("PTY transcript chars:", sum(len(x) for x in out))

print("\n===== WIRE REQUESTS =====")
with open(env["MOCK_LOG"]) as f:
    for line in f:
        e = json.loads(line)
        b = e.get("body") or {}
        for m in b.get("messages", []):
            c = m.get("content")
            txt = c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)
            print(f"  [{m.get('role')}] {txt[:400]}")
print("\n===== INPUT EVENTS =====")
try:
    with open(env["PROBE_EVENTS"]) as f:
        print(f.read())
except FileNotFoundError:
    print("(none)")
