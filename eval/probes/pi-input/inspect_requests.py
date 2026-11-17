#!/usr/bin/env python3
"""Summarize captured mock-server requests: role and text of each message."""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/vestigio-probe/requests.jsonl"
show_system = "--system" in sys.argv
with open(path) as f:
    for i, line in enumerate(f):
        line = line.strip()
        if not line:
            continue
        e = json.loads(line)
        b = e.get("body") or {}
        print(f"--- request #{i+1} {e['ts']} model={b.get('model')} stream={b.get('stream')}")
        for m in b.get("messages", []):
            role = m.get("role")
            if role == "system" and not show_system:
                print(f"  [{role}] <{len(str(m.get('content')))} chars>")
                continue
            content = m.get("content")
            print(f"  [{role}] {json.dumps(content, ensure_ascii=False)}")
        if b.get("tools"):
            print(f"  tools: {[t.get('function',{}).get('name') for t in b['tools']]}")
