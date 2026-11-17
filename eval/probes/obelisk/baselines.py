#!/usr/bin/env python3
"""Baselines for `obelisk --search` against an isolated fixture.

For each corpus it records wall time and bytes returned for:
  - `obelisk --version`                     (process-startup floor, no refresh)
  - a no-op `--query` script                (refresh + open + sandbox, no search)
  - an explicit `obelisk --build`
  - a warm `--search` inside the 30 s recent-build debounce (refresh skipped)
  - a cold `--search` with `__last_build__` deleted (refresh runs a full strict
    inventory build before the query)

Usage: baselines.py <evidence-dir> [repeats]
"""
import json
import os
import statistics
import subprocess
import sys
import time

EV = sys.argv[1]
REPEATS = int(sys.argv[2]) if len(sys.argv) > 2 else 5
HERE = os.path.dirname(os.path.abspath(__file__))
NOOP = os.path.join(HERE, "noop_query.mjs")
SUITES = [
    ("fixture", "/tmp/obelisk-probe/base-home", 0, 0),
    ("big", "/tmp/obelisk-probe/big-home", 200, 50),
]


def run(cmd, env):
    t0 = time.perf_counter()
    p = subprocess.run(cmd, env=env, capture_output=True)
    dt = time.perf_counter() - t0
    return dt, p.returncode, p.stdout, p.stderr


def reset_last_build(db, env):
    code = (
        "import {DatabaseSync} from 'node:sqlite';"
        "const db=new DatabaseSync(process.argv[1]);"
        "db.exec(\"DELETE FROM index_state WHERE jsonl_path='__last_build__'\");"
        "db.close();"
    )
    subprocess.run(["node", "--input-type=module", "-e", code, db],
                   check=True, env=env, capture_output=True)


def stats(name, samples, extra):
    row = {
        "name": name,
        "repeats": len(samples),
        "wall_s": [round(s, 4) for s in samples],
        "median_s": round(statistics.median(samples), 4),
        "min_s": round(min(samples), 4),
        "max_s": round(max(samples), 4),
    }
    row.update(extra)
    return row


def machine_info(env):
    info = {}
    for key, cmd in {
        "machine": ["sysctl", "-n", "hw.model"],
        "cpu": ["sysctl", "-n", "machdep.cpu.brand_string"],
        "cpu_cores": ["sysctl", "-n", "hw.ncpu"],
        "mem_bytes": ["sysctl", "-n", "hw.memsize"],
        "macos": ["sw_vers", "-productVersion"],
        "node": ["node", "--version"],
        "obelisk": ["obelisk", "--version"],
        "python": ["python3", "--version"],
    }.items():
        try:
            info[key] = subprocess.run(cmd, capture_output=True, text=True, env=env).stdout.strip()
        except FileNotFoundError:
            info[key] = None
    real = "/Users/snake/.obelisk/obelisk.sqlite"
    info["operator_real_db_bytes_not_measured"] = os.path.getsize(real) if os.path.exists(real) else None
    return info


def suite(label, home_dir, extra_sessions, msgs_per_session):
    env = dict(os.environ, HOME=home_dir)
    gen_env = dict(env, EXTRA_SESSIONS=str(extra_sessions),
                   MSGS_PER_SESSION=str(msgs_per_session))
    subprocess.run([os.path.join(HERE, "make_fixture.sh"), home_dir],
                   check=True, capture_output=True, env=gen_env)
    db = os.path.join(home_dir, ".obelisk", "obelisk.sqlite")

    info = machine_info(env)
    corpus_files = []
    for root, _, files in os.walk(os.path.join(home_dir, ".pi")):
        for f in files:
            if f.endswith(".jsonl"):
                p = os.path.join(root, f)
                corpus_files.append({"path": p, "bytes": os.path.getsize(p)})
    info["label"] = label
    info["corpus_jsonl_files"] = len(corpus_files)
    info["corpus_bytes"] = sum(f["bytes"] for f in corpus_files)

    results = [info]

    samples, codes = [], []
    for _ in range(REPEATS):
        dt, rc, out, err = run(["obelisk", "--version"], env)
        samples.append(dt)
        codes.append(rc)
    results.append(stats("version_startup_floor", samples,
                         {"exit_codes": sorted(set(codes))}))

    # prime the index once so the no-op query is not paying for a first build
    run(["obelisk", "--build"], env)
    samples, codes = [], []
    for _ in range(REPEATS):
        dt, rc, out, err = run(["obelisk", "--query", NOOP], env)
        samples.append(dt)
        codes.append(rc)
    # executeQuery always treats the script path/content as an invocation nonce;
    # on a miss it runs one recovery build and then polls for up to
    # INVOCATION_POLL_CAP_MS (4000) before returning null. This row includes
    # that poll -- it is not a clean "refresh only" cost.
    results.append(stats("noop_query_includes_invocation_nonce_poll", samples,
                         {"exit_codes": sorted(set(codes))}))

    samples, codes, sizes = [], [], []
    for _ in range(REPEATS):
        dt, rc, out, err = run(["obelisk", "--build"], env)
        samples.append(dt)
        codes.append(rc)
        sizes.append(len(out) + len(err))
    results.append(stats("explicit_build", samples,
                         {"exit_codes": sorted(set(codes)), "bytes": sizes}))

    run(["obelisk", "--build"], env)
    samples, codes, sizes = [], [], []
    for _ in range(REPEATS):
        dt, rc, out, err = run(["obelisk", "--search", "zqleak"], env)
        samples.append(dt)
        codes.append(rc)
        sizes.append(len(out))
    results.append(stats("warm_search_refresh_skipped", samples,
                         {"exit_codes": sorted(set(codes)), "stdout_bytes": sizes}))

    samples, codes, sizes = [], [], []
    for _ in range(REPEATS):
        reset_last_build(db, env)
        dt, rc, out, err = run(["obelisk", "--search", "zqleak"], env)
        samples.append(dt)
        codes.append(rc)
        sizes.append(len(out))
    results.append(stats("cold_search_refresh_runs", samples,
                         {"exit_codes": sorted(set(codes)), "stdout_bytes": sizes}))

    # refresh after a source file changed: append one entry to the largest
    # session file so the incremental build must reparse that file.
    changed = sorted(corpus_files, key=lambda f: f["bytes"])[-1] if corpus_files else None
    extra_row = None
    if changed and label == "big":
        with open(changed["path"], "a", encoding="utf-8") as fh:
            fh.write('{"id":"appended-1","parentId":"big1-e50","type":"message",'
                     '"timestamp":"2026-02-01T00:59:59.000Z","message":{"role":"user",'
                     '"content":[{"type":"text","text":"zqleak appended marker text"}]}}\n')
        reset_last_build(db, env)
        dt, rc, out, err = run(["obelisk", "--search", "zqleak"], env)
        extra_row = stats("cold_search_after_one_file_changed", [dt],
                          {"exit_codes": [rc], "stdout_bytes": [len(out)]})
        results.append(extra_row)
    # rebuild once more so the report's trailing state is consistent
    run(["obelisk", "--build"], env)

    # indexed message count (reflects the latest cold run's index)
    dt, rc, out, err = run(["obelisk", "--query", os.path.join(HERE, "dump_uuids.mjs")], env)
    if not err:
        try:
            info["indexed_messages"] = len(json.loads(out)["messages"])
        except Exception:
            info["indexed_messages"] = None

    with open(os.path.join(EV, f"baselines_{label}.json"), "w") as fh:
        json.dump(results, fh, indent=2)
    for row in results:
        print(json.dumps({k: v for k, v in row.items() if k != "corpus_jsonl_files"},
                         ensure_ascii=False))


def main():
    os.makedirs(EV, exist_ok=True)
    with open(NOOP, "w") as fh:
        fh.write("// no-op query: pays refresh + db open + sandbox only.\nreturn 1;\n")
    for label, home_dir, extra, msgs in SUITES:
        suite(label, home_dir, extra, msgs)


if __name__ == "__main__":
    main()
