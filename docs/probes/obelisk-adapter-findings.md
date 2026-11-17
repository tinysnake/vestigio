# Obelisk adapter findings — what the installed build actually does vs what its docs advertise

Probe of the Obelisk CLI on this machine for **vestigio PR-03** (Obelisk read-only source
adapter). The upstream `api-reference.md` advertises `projectPath`, `contextLimit` and
`snippetTokens`; the **installed** `/opt/homebrew/bin/obelisk` was **0.3.0** during this probe
and silently ignores all three. (The global install has since been upgraded to **0.3.2**, the
same version this doc pins for PR-03; §7a covers what that means for an existing index.) Everything below was measured against a throwaway data directory, not the
operator's real history. Upstream source is **AGPL-3.0-only** and was read, never copied into
this repo.

- Installed artifact at probe time: `obelisk --version` -> `0.3.0` (`/opt/homebrew/bin/obelisk`);
  the global install is now `0.3.2`, which is also the pin.
- Recommended pin for PR-03: **`@obelisk-apps/cli@0.3.2`** (npm `latest`) — see §7.
- Raw evidence: `eval/probes/obelisk/evidence/`; reproduce all of it with
  `eval/probes/obelisk/run_all.sh`.

## 0. Isolated fixture recipe (why the operator's history is safe)

`os.homedir()` honours `$HOME`, and all Obelisk state is derived from it
(`dist/core/src/db.js:12-14`: `OBELISK_DIR = join(homedir(), '.obelisk')`,
`DB_PATH = join(OBELISK_DIR, 'obelisk.sqlite')`). Pointing `HOME` at a throwaway directory
therefore redirects the index DB, the writer lock, and every provider root away from
`~/.obelisk`. Verified:

```sh
node -e 'console.log(require("os").homedir())'                 # honours $HOME
HOME=/tmp/obelisk-probe-test node -e 'console.log(require("os").homedir())'
#   -> /tmp/obelisk-probe-test
```

Recipe (already scripted as `eval/probes/obelisk/make_fixture.sh`):

```sh
FIX=/tmp/obelisk-probe/home
eval/probes/obelisk/make_fixture.sh "$FIX"       # writes $FIX/.pi/agent/sessions/**.jsonl
HOME="$FIX" obelisk --build                      # -> {"ok":true,"db":"$FIX/.obelisk/obelisk.sqlite"}
```

The fixture has two pi sessions so cross-project filtering can be tested:

| session | `cwd` | derived project slug | token | notable rows |
|---|---|---|---|---|
| `projA/sessA.jsonl` | `/tmp/x_a` | `-tmp-x_a` | `zqleak` | active `a1->a2->a3`, inactive branch `b1`, hidden `custom_message h1` (`display:false`), is-meta `custom_message m1`, `leaf` pin |
| `projB/sessB.jsonl` | `/tmp/x-a` | `-tmp-x-a` | `zqleak` | one message (LIKE-leak canary for `_`) |

`ls -l ~/.obelisk/obelisk.sqlite` before/after a full probe run was unchanged; the real DB is
6,971,248,640 bytes and was only `stat`ed, never queried or written. **No write path was ever
exercised against it**, and `obelisk install` / `--attune` were never run.
Caveat: the real DB's mtime read `2026-11-17 16:29:33` during this shared-checkout session and
stayed frozen at that value across every later probe run (`run_all.sh` at 16:33–16:36). Every
Obelisk invocation in these scripts and in `evidence/` sets `HOME` to a throwaway dir, so the
16:29 event is not attributable to this probe's runs (it predates the first `run_all.sh`; a
sibling agent or an early smoke command is the likely source). In any case an index refresh
writes index state, never provider history or memory.

## 1. Capability matrix — one exact command per row (installed 0.3.0)

Setup for every row:

```sh
FIX=/tmp/obelisk-probe/home
eval/probes/obelisk/make_fixture.sh "$FIX"
HOME="$FIX" obelisk --build >/dev/null
q() { HOME="$FIX" obelisk --query /dev/stdin; }   # obelisk executeQuery reads /dev/stdin as the script
```

| # | Question | Exact command | Observed |
|---|---|---|---|
| 1 | honoured: `limit` | `echo 'return search("zqleak",{limit:1}).length' \| q` | `1` |
| 2 | honoured: `project` (LIKE) | `echo 'return search("zqleak",{project:"-tmp-x_a"}).map(r=>r.session.project)' \| q` | `["-tmp-x_a","-tmp-x_a","-tmp-x_a","-tmp-x-a"]` |
| 3 | honoured: `cwd` (LIKE) | `echo 'return search("zqleak",{cwd:"/tmp/x_a"}).map(r=>r.message.cwd)' \| q` | includes `/tmp/x-a` |
| 4 | honoured: `sessionId` (full id) | `echo 'return [...new Set(search("zqleak",{sessionId:"<full pi session id>"}).map(r=>r.session.id))]' \| q` | `["pi:sessA:d5765ae…186f"]`; a short id returns `0` (no error) |
| 5 | honoured: `source` | `echo 'return [search("zqleak",{source:"pi"}).length, search("zqleak",{source:"claude"}).length]' \| q` | `[4,0]` (4 visible; meta hidden) |
| 6 | honoured: `after` / `before` | `echo 'return [search("zqleak",{after:"2026-01-01T00:00:02Z"}).length, search("zqleak",{before:"2026-01-01T00:00:02Z"}).length]' \| q` | `[2,2]` |
| 7 | honoured: `includeMeta` | `echo 'return [search("zqleak").length, search("zqleak",{includeMeta:true}).length]' \| q` | `[4,5]` (meta envelope hidden by default) |
| 8 | honoured: `includeInactive` | `echo 'return [search("zqleak").length, search("zqleak",{includeInactive:true}).length]' \| q` | `[4,5]` (inactive `b1` only with flag) |
| 9 | honoured: `fallback` | `echo 'return [search("zqleak zzznomatchzzz").length, search("zqleak zzznomatchzzz",{fallback:"or"}).length]' \| q` | `[0,4]` |
| 10 | **ignored: `projectPath`** | `echo 'return search("zqleak",{projectPath:"/tmp/x-a"}).map(r=>r.session.project)' \| q` | both projects returned |
| 11 | **ignored: `contextLimit`** | `echo 'return search("zqleak",{contextLimit:0}).map(r=>r.context.length)' \| q` | nonzero neighbor arrays |
| 12 | **ignored: `snippetTokens`** | `echo 'return search("zqleak",{snippetTokens:4}).map(r=>r.message.text)' \| q` | full text, not an excerpt |
| 13 | unknown search key ignored | `echo 'return search("zqleak",{totallyUnknownOption:123}).length' \| q` | `4` (no error) |
| 14 | unknown `messages()` key throws | `echo 'return messages({uuid:"a1",totallyUnknownOption:1})' \| q` | `Error: messages() does not support option totallyUnknownOption` |
| 15 | bounded hit context | `echo 'return search("zqleak")[0].context.length' \| q` | `2` (inline neighbor array, ≤6) |
| 16 | bounded `around` window | `echo 'const u=search("zqleak")[0].message.uuid; return Object.keys(messages({around:u,relation:"timeline",beforeCount:1,afterCount:1}))' \| q` | `["anchor","messages","session","hasMore","nextCursor"]` |
| 17 | parents bounded | `echo 'const u=search("zqleak")[2].message.uuid; return messages({around:u,relation:"parents",beforeCount:3}).messages.map(x=>x.text)' \| q` | 3-entry ancestor chain + anchor |
| 18 | parents requires afterCount 0 | `echo 'const u=search("zqleak")[0].message.uuid; return messages({around:u,relation:"parents",afterCount:1})' \| q` | `messages() parents relation requires afterCount: 0` |
| 19 | 500-window cap | `echo 'const u=search("zqleak")[0].message.uuid; return messages({around:u,relation:"timeline",beforeCount:400,afterCount:400})' \| q` | `messages() window must contain at most 500 messages including the anchor` |
| 20 | hidden never returned | see heredoc below | `[null,null]` (both calls) |
| 21 | inactive only with flag | see heredoc below | `[null,{…}]` (default null) |
| 22 | query triggers refresh | `HOME="$FIX" obelisk --build` then `HOME="$FIX" obelisk --search zqleak` | search returns; `index_state.__last_build__` updated by the refresh |
| 23 | writer lock does not block | hold `BEGIN IMMEDIATE` on `$FIX/.obelisk/writer.lock.sqlite`, delete `__last_build__`, then `HOME="$FIX" obelisk --search zqleak` | exit 0, empty stderr, 0.536 s (refresh skipped as `writer_busy`) |
| 24 | UUID stable across rebuild | `eval/probes/obelisk/uuid_stability.sh eval/probes/obelisk/evidence/uuid-stability` | `uuid_set_identical=True` after rebuild/move/rename |
| 25 | UUID not content-stable | same script, `step5_inserted` | prepend renumbers later ordinals; `same_uuid_new_text=1` |

The full matrix with all inputs/outputs is regenerated as JSON by `queries.mjs` / `run_all.sh`.

Rows 20/21 need a UUID that search() will not return (hidden/inactive), so they read it from the
sandbox's `sql` helper:

```sh
q <<'JS'
const h = sql("SELECT uuid FROM messages WHERE visibility='hidden'")[0].uuid;
const i = sql("SELECT uuid FROM messages WHERE visibility='inactive'")[0].uuid;
return [messages({uuid:h}), messages({uuid:h,includeInactive:true}),
        messages({uuid:i}), !!messages({uuid:i,includeInactive:true})];
JS
# -> [null,null,null,true]
```

Hit/session shape: `r.session` has keys `{id, title, project, started_at, source}` — the id is
`pi:sessA:<hash>` and the `sessionId` **option** requires that full id; `r.message` carries
`{text, uuid, cwd, timestamp, visibility, isMeta, ...}` and hits also carry an inline
`context` array. `messages()` accepts only a **full** UUID (`uuid:"1:message:block:0000"`
returned `null`; suffix matching is not done). The query sandbox also exposes a `sql(text)`
helper that can read the index tables directly; whether it permits writes was not tested
("not verified"), which matters for PR-03's rule that the model never supplies arbitrary SQL.

## 2. Exact identity vs `LIKE` (question 2)

0.3.0 `query.js` filters with `s.project LIKE ?` and `m.cwd LIKE ?`, and passes the caller's
string as the LIKE pattern. Consequence, proven in row 2/3: querying `project:"-tmp-x_a"`
returns hits from project `-tmp-x-a` because SQL `_` matches `-`; `project:"-tmp-x%"` returned
all 4. **`project` and `cwd` are not exact identity** — PR-03 must post-filter in the adapter
(or pin 0.3.2 and use `projectPath`, which is exact `sessions.project_path = ?`, verified in §7).
`sessionId` and `source` *are* exact (`=`), though `sessionId` needs the full `pi:<name>:<hash>`
id.

## 3. Bounded context and causal parents (question 3)

Yes, without pulling unbounded history:

- Every search hit already carries an inline `context` array (temporal neighbors, ≤6, row 15).
- `messages({around, relation:'timeline', beforeCount, afterCount})` is bounded and
  **synchronous** (returns an object, not a Promise — `.then` throws); defaults are
  `beforeCount:3, afterCount:3`.
- `messages({around, relation:'parents', beforeCount})` follows causal parents and is bounded;
  `afterCount` must be `0` (row 18), and ancestors + anchor must fit the 500-message window
  (row 19) or it throws.
- Return shape is **`{anchor, messages, hasMore, nextCursor}`** (row 16), not a bare
  array — the adapter must read `.messages`.

## 4. Hidden / inactive visibility (question 4)

`normalizedVisibility` yields `visible | inactive | hidden`; `isQueryableMessage` admits
`hidden` **never**, and admits `inactive` **only** when `includeInactive` is true.
`visibilitySql` without the flag filters to `'visible'` alone. Verified rows 20/21:
`includeInactive` behaves exactly as documented; hidden rows are unreachable through the
query API regardless of flags. pi `custom_message` entries with `display === false` are
stored as `hidden` and `is_meta=1`.

## 5. Refresh trigger, cost, and locks (question 5) — the important one

Both `searchText` and `executeQuery` call `refreshQueryIndex()` before every query, which calls
`buildIndex({readMode:'strict'})`. `buildIndex`:

- skips if the last `__last_build__` row is younger than `BUILD_DEBOUNCE_MS = 30000`, or if an
  app heartbeat is fresh (`APP_HEARTBEAT_FRESH_MS = 60000`);
- otherwise runs an **incremental** pass keyed on per-file cursors (cheap when files are
  unchanged), acquiring a writer lease with `waitMs:0`;
- if the lease is busy it returns `{skip:true, reason:'writer_busy'}` and the query still runs
  against the existing index — measured: exit 0, empty stderr, 0.536 s (row 23).

Separately, **`--query` (executeQuery) pays an invocation-nonce poll**: the script path/content
is always submitted as a nonce; on a miss it runs one recovery build and polls up to
`INVOCATION_POLL_CAP_MS = 4000` ms before returning `null`. Measured no-op `--query` ≈ 4.2–4.6 s
median on both corpora — that is the poll, **not** refresh cost. `--search` without `--nonce`
skips this path entirely. **PR-03's hot path should prefer `--search` / a single
`search()` script over repeated `--query` invocations**, or it will pay ~4 s per call.
Refresh writes only index state (and the writer lock) inside the isolated DB, not the provider
`.jsonl` sources (code-inspection; the indexer opens sources for reading — not separately
tested).

## 6. UUID stability (question 6)

pi message UUID = `${sessionId}:entry:${line-ordinal padded to 6}:message:block:${block}`
(`providers/pi.js:805`). Verified:

- **stable** across a full index rebuild, a move of the source file to another project
  directory under the sessions root, and a rename (`uuid_set_identical=True` each time; the
  stored `jsonl_path` follows the file).
- **not content-stable**: prepending an entry renumbers every later ordinal, so the *same*
  UUID string is reused for different text (`step5_inserted`: `same_uuid_new_text=1`, one
  gained). PR-03's `SourceRef` mapping must treat the UUID as stable only under append-only
  growth, and re-derive or version it when a source file is rewritten.

## 7. Newer published release supports the advertised options (question 8)

- `npm view @obelisk-apps/cli dist-tags` -> `{latest: "0.3.2", rc: "0.2.6-rc.0"}`; versions
  `... 0.3.0, 0.3.1, 0.3.2`. GitHub releases/tags lag npm (max `v0.2.5`), so **npm is the
  authoritative channel**.
- `api-reference.md` on `main` documents `opts.projectPath` (exact match on
  `sessions.project_path`), `opts.contextLimit` (integer 0–6, default 6, 0 skips neighbors),
  `opts.snippetTokens` (integer 1–64, FTS excerpt instead of full text).
- `npm pack @obelisk-apps/cli@0.3.1` `dist/core/src/query.js`: **zero** occurrences of the
  three names; destructure is
  `{limit=20,sessionId,project,after,before,cwd,source,includeMeta=false,includeInactive=false,fallback}`.
- `@0.3.2`: all three present; destructure is
  `{limit=20,sessionId,project,projectPath,after,before,cwd,source,includeMeta=false,includeInactive=false,contextLimit=6,snippetTokens,fallback}`.
- Ran 0.3.2 against the same isolated fixture:
  - `projectPath:"/tmp/x_a"` -> only `-tmp-x_a`; `projectPath:"/tmp/x-a"` -> only `-tmp-x-a`
    (exact identity, **leak fixed**);
  - `contextLimit:0` -> every `context` array empty; default -> `[2,2,2,0]`;
  - `contextLimit:7` -> `RangeError: search() contextLimit must be an integer from 0 to 6`;
  - `snippetTokens:4` -> `{text:"zqleak alpha first user…",isSnippet:true,textLength:31}`.

**Pin `@obelisk-apps/cli@0.3.2`.** 0.3.0 cannot satisfy PR-03's exact-project requirement and
forces unbounded/oversized payloads; 0.3.1 is the same as 0.3.0 for these options.

## 7a. Schema compatibility with an existing index — closed by measurement

This was raised as a blocking risk for PR-03: a local 0.3.2 opening an index built by 0.3.0
could apply a schema migration and break the globally installed reader. It does not, and the
operator's index has nothing pending.

Why a read path cannot migrate:

- `dist/core/src/db.js` `openReadDb()` opens `new DatabaseSync(DB_PATH, { readOnly: true })` and
  only sets `PRAGMA busy_timeout=250`; db.js:42 records the rule: "Queries and daemon-arbitration
  checks must never migrate/configure the index".
- `ALTER TABLE` exists only in `openDb()` and `openAttuneDb()`, driven by the 15 entries of
  `COLUMN_MIGRATIONS` in `dist/core/src/schema-migrations.js`, and every entry is an additive
  `ALTER TABLE ... ADD COLUMN`.

The operator's real index (~6.97 GiB):

- It already carries all 15 columns (`sessions` 11, `memories` 11, `messages` 19);
  `coreSchemaNeedsMigration()` returns `false`, so opening it triggers nothing.
- `0.3.2 --search "vestigio" --limit 2` exited 0 with a normal message body, and the column
  counts were identical before and after. Cold run **59.9 s** (it includes the incremental
  refresh); warm run immediate.

Only an index predating those columns is touched at all: against a fixture index built by 0.3.0,
a 0.3.2 write path added `index_state.replay_required INTEGER NOT NULL DEFAULT 0` (one additive
ALTER), and 0.3.0 read that file correctly afterwards — identical search hits, identical
`--query` output across 39 keys, `--build` still `{"ok":true}`. The adapter never calls
`--build`/`--attune` and never opens the database itself (only `openReadDb()`-equivalent work
happens inside the CLI's own read commands).

### 7.1 Operational notes measured while building the adapter

- **stderr is not a failure signal.** pi writes `observation-pack/ledger.jsonl` inside session
  directories, so every Obelisk build emits dozens of lines of
  `Warning: skipped pi artifact ...: Unsupported or malformed Pi session header` on stderr.
  Success must be decided from the exit code plus the JSON on stdout alone; stderr is kept for
  diagnostics and never treated as an error. The boundary was measured too: a *malformed pi
  session header* is a hard failure, not a warning — `--build` prints the same `Warning:` line,
  then `{"error":"Index rebuild was not published: provider_failure"}` and exits 1. So the rule is
  "exit code and stdout decide", not "ignore stderr content and assume success".
- **`--query` keeps its nonce tax.** `executeQuery` always runs the script it is handed and pays
  invocation-nonce resolution first; when the nonce cannot resolve that is the ~4 s poll.
  Measured here: **4.30 s** per `--query` call versus **0.18 s** for `--search`. Routine retrieval
  therefore stays on `--search` (0.3.2 there also supports `--project-path`, `--snippet-tokens`
  and `--context-limit 0..6`); the script path is reserved for what `--search` cannot express
  (parent resolution, per-hit `project_path`).

## 8. Baselines (question 9)

`eval/probes/obelisk/baselines.py`, 5 repeats, isolated `HOME`, wall-clock seconds including
Node startup; raw JSON in `evidence/baselines*.json`.

Settings: machine `Mac16,12` / Apple M4 / 10 cores / 17179869184 bytes RAM / macOS
27.0.1; runtime Node `v26.13.0`, obelisk `0.3.0`, Python `3.15.2`; cold = `__last_build__`
cleared before the sample, warm = a build within the 30 s debounce; single client, no
concurrency; corpus as below.

| corpus | bytes | msgs | version floor | noop `--query` | explicit `--build` | warm search | cold search | search bytes |
|---|---|---|---|---|---|---|---|---|
| fixture | 1,542 | 7 | 0.2624 | 4.2279 | 0.1814 | 0.1802 | 0.1800 | 5,421 |
| big (200×50) | 2,139,234 | 10,008 | 0.4342 | 4.3287 | 2.7334 | 0.2791 | 0.3339 | 57,611 |

One direct CLI search (median): **0.18 s** on the fixture, **0.28 s** on the 10k-message corpus,
returning **5,421** / **57,611** bytes respectively. Refresh cost separately: warm is inside the
startup noise; cold incremental refresh is also inside noise at these sizes (the pass is a
per-file cursor check), while a forced full `--build` costs **2.73 s** at 10k messages. After
changing one source file, the next cold search (incremental reparse of that file) took
**0.7808 s**.

**These numbers do not extrapolate to the operator's real index** (6.49 GiB, never measured
because any query would refresh/write it). At probe scale everything is dominated by ~0.2–0.4 s
Node process startup; treat them as a floor for CLI-per-call adapters, and prefer one persistent
process or batched `--query` scripts in PR-04.

## 9. Artifact to pin and license

- Pin **`@obelisk-apps/cli@0.3.2`** by exact version (npm `latest` as of this probe); record the
  resolved tarball integrity in the lockfile. 0.3.0 is missing the exact-project and bounded
  payload options; 0.3.1 == 0.3.0 for them.
- License: upstream declares **AGPL-3.0-only** (`development-plan.md §7`). PR-03 wraps the CLI as
  a process boundary and does **not** copy or vendor its source or private internal modules;
  none of its code was copied into this repo.

## Not verified

- Per-file refresh breakdown on the operator's real index: only the cold/warm pair in §7a
  (59.9 s cold including refresh, immediate warm) was taken, to avoid writing it more often than
  necessary.
- Concurrency beyond a single held writer lease (e.g. multiple simultaneous cold refreshes).
- Whether `projectPath` in 0.3.2 resolves symlinked/relative project roots (only the two fixture
  paths were exercised).
- Behaviour on obelisk versions newer than 0.3.2 (none published at probe time).

## Repo state note

A concurrent sibling commit `38b9f1d` ("feat(core): freeze PR-01 memory contracts, eval fixtures
and baseline harness") swept these probe scripts into git while this probe was running. **No
`git add`/`commit`/`push` was run by this probe**; `eval/probes/obelisk/evidence/` and
`eval/probes/obelisk/run_all.sh` remain untracked.
