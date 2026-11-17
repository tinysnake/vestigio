# Obelisk fixture — the ground truth the adapter is tested against

An isolated Obelisk index built from two pi sessions whose derived project slugs differ by one
character (`/tmp/x_a` -> `-tmp_x_a`-shaped `-tmp-x_a` vs `/tmp/x-a` -> `-tmp-x-a`). That one
character is the whole point: a SQL `LIKE` on the first slug also matches the second, which is the
cross-project leak the adapter has to prove it cannot commit.

Every command here runs with `HOME` pointing inside a scratch directory. Obelisk derives its
database, writer lock and provider roots from `os.homedir()`, so nothing in this recipe can touch
`~/.obelisk/obelisk.sqlite`.

## Build it

```sh
FIX=$(mktemp -d)/home
eval/fixtures/obelisk/build_fixture.sh "$FIX"
# fixture home: .../home
# manifest:     .../home/fixture-manifest.json
```

The script:

1. resolves the pinned CLI (`packages/source-obelisk/node_modules/@obelisk-apps/cli`, 0.3.2) —
   override with `OBELISK_BIN`;
2. writes the corpus with `eval/probes/obelisk/make_fixture.sh` (sessions `sessA` in `/tmp/x_a`,
   `sessB` in `/tmp/x-a`; active chain `a1->a2->a3`, abandoned `b1`, meta `m1`, hidden `h1`);
3. runs `--build` with `HOME="$FIX"` and one warm `--search` so the first query index exists;
4. probes the two projects plus the `LIKE` leak, asserts `3 / 1 / 4`, and writes
   `fixture-manifest.json`.

Recorded result at `@obelisk-apps/cli@0.3.2`:

```json
{
  "index_bytes": 229376,
  "cli_version": "0.3.2",
  "observed": {
    "exact_project_x_a_count": 3,
    "exact_project_x_a_slugs": ["-tmp-x_a"],
    "like_leak_count": 4,
    "like_leak_projects": ["-tmp-x-a", "-tmp-x_a"]
  }
}
```

## Query it

The CLI is spawned as `node <entry>`; `HOME` must be the fixture home for every call.

```sh
CLI=packages/source-obelisk/node_modules/@obelisk-apps/cli/dist/cli/src/obelisk.js

# exact project scope: the only correct way to filter
HOME=$FIX node $CLI --search zqleak --limit 20 --project-path /tmp/x_a --context-limit 0
#  3 hits, every session.project == "-tmp-x_a"

HOME=$FIX node $CLI --search zqleak --limit 20 --project-path /tmp/x-a --context-limit 0
#  1 hit, session.project == "-tmp-x-a"

# the leak, demonstrated: `project` is a LIKE pattern, `_` matches any character.
# Prints the 4 rows that match, spanning both projects:
#   [{uuid, project:"-tmp-x_a", cwd:"/tmp/x_a"} ×3, {uuid, project:"-tmp-x-a", cwd:"/tmp/x-a"}]
HOME=$FIX node $CLI --query eval/fixtures/obelisk/like_leak.query.mjs

# the rows behind the visibility rules, with the ids the live tests assert on.
# Prints 7 rows: {uuid, session_id, parent_uuid, text, visibility, is_meta}
#   visible a1,a2,a3 | inactive b1 | visible m1 (is_meta 1) | hidden h1 | visible sessB c1
HOME=$FIX node $CLI --query eval/fixtures/obelisk/evidence_rows.query.mjs
```

`--query` costs about 4 seconds per call (the CLI always pays its invocation-nonce poll), so the
two scripts above are for inspection, not for the adapter's hot path. `--search` returns in
~0.2–0.4 s on this fixture.

## Run the live tests against a fresh copy

```sh
VESTIGIO_OBELISK_LIVE=1 pnpm --filter @vestigio/source-obelisk test:live
```

The suite builds its own fixture per run (and a private copy per rebuild test), so it never reads
this directory's index and never touches the operator's history. It prints each command's output
as `[live] …` lines so failures are reviewable, not just red.

## What each case is for

| case | what it proves |
| --- | --- |
| `--project-path /tmp/x_a` | exact project scoping returns only that project |
| `--project-path /tmp/x-a` | the sibling slug is not swept in |
| `like_leak.query.mjs` | `project`/`cwd` filtering is a `LIKE`, so it must never be used for scope |
| `include_inactive` | an abandoned branch is invisible by default and readable only when asked |
| hidden row | is never returned by search or read, with or without `include_inactive` |
| `relation: "parents"` | the causal chain, not the timeline, needs `afterCount: 0` |
| rebuild / moved source file | message id and content hash survive; the locator follows the file |
| empty home | a missing index reports `index_missing`, never “no results” |

## Notes

- The fixture is disposable: `build_fixture.sh` rewrites its target home wholesale.
- `--build` is a *write* path (it republishes the index). The adapter never calls it; only this
  script and the tests that deliberately rebuild do.
- A malformed pi session header aborts a rebuild (`{"error":"Index rebuild was not published:
  provider_failure"}`, exit 1), while unparseable-but-known artifacts such as
  `observation-pack/ledger.jsonl` only produce `Warning:` lines on stderr. Exit code plus stdout
  JSON decide success; stderr alone does not.
