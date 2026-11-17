# Vestigio contracts (PR-01)

Frozen boundary shapes for the memory system. Everything that enters the system
— pi extension callbacks, CLI input, Obelisk output, rows read back from
storage — is parsed by the matching `parse*` function before the code trusts it.
The TypeScript types alone are not the contract; the parser plus these rules is.

Source of truth: `packages/core/src/contracts/`. The types live in `types.ts`;
this document mirrors them and states the rules the parsers enforce.

## Compatibility range

| Component | Frozen range | Verified here |
| --- | --- | --- |
| Node | `>=22.5` (`engines`) | v26.13.0, the node that runs pi 1.5.2 |
| pi | `@earendil-works/pi-coding-agent` 1.5.2 | 1.5.2 |
| SQLite | `node:sqlite` (Node built-in), FTS5 | available on v26.13.0; `tokenize='trigram'` verified by hand |
| TypeScript | `^7.0.2` (devDependency) | 7.0.2 |
| Module format | ESM, `module`/`moduleResolution` `NodeNext` | `tsc --noEmit` clean |
| Package manager | pnpm workspace | pnpm 10.33.0 (the plan said 11; the installed pnpm is 10.33.0) |
| Runtime dependencies in `packages/core` | none | `dependencies` is absent |

`devDependencies` allowed: `typescript`, `@types/node`, `vitest`. Nothing else.
`node:crypto` is used for event ids; it is a Node built-in, not a runtime
dependency.

## Shapes

```ts
type StoreId = string;
type MemoryId = string;
type MemoryUri = `memory://${StoreId}/${MemoryId}`;
type Revision = number;

type Scope = { kind: "project"; project_id: string } | { kind: "global" };

type SourceRef = {
  provider: string;
  source_instance: string;
  session_id: string;
  message_id: string;
  parent_message_id: string | null;
  project_id: string;
  timestamp: string;
  content_hash: string;
  locator: string | null;
};

type MediumSummary = { body: string; body_char_count: number; sources: SourceRef[] };
type NavSummary = { text: string; char_count: number; source_revision: Revision };

type MemoryState = "medium_ready" | "published" | "archived";

type Memory = {
  memory_id: MemoryId;
  uri: MemoryUri;
  scope: Scope;
  title: string;
  keywords: string[];
  revision: Revision;
  state: MemoryState;
  medium: MediumSummary;
  nav: NavSummary | null;
  hit_count: number;
  access_count: number;
  last_access_at: string | null;
  created_at: string;
  updated_at: string;
};

type UsageEventKind = "hit" | "access";
type UsageChannel = "hotspot" | "search" | "read";
type UsageEvent = {
  event_id: string;
  memory_id: MemoryId;
  revision: Revision;
  kind: UsageEventKind;
  channel: UsageChannel;
  session_id: string;
  input_id: string;
  at: string;
  dedup_key: string;
};

type InjectionReceipt = {
  store_id: StoreId;
  session_id: string;
  branch_ref: string;
  input_id: string;
  memory_id: MemoryId;
  revision: Revision;
  committed_at: string;
};

type ProjectActivity = { project_id: string; activity_seq: number; last_input_at: string };

type HotspotMembership = {
  project_id: string;
  memory_id: MemoryId;
  admitted_seq: number;
  last_hit_seq: number;
  last_access_seq: number;
  recent_hit_weight: number;
  recent_access_weight: number;
};

type RetrievalStatus = "resolved" | "partial" | "conflicted" | "not_found";
type PersistenceStatus = "saved" | "failed" | "not_attempted";
type NavigationStatus = "pending" | "ready" | "failed";

type MemoryCard = {
  memory_id: MemoryId;
  uri: MemoryUri;
  scope: Scope;
  title: string;
  nav_text: string;
  revision: Revision;
  state: MemoryState;
  score: number;
  hit_count: number;
  access_count: number;
  last_access_at: string | null;
};

type BudgetUsed = {
  elapsed_ms: number;
  model_calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
};

type RetrievalResult = {
  status: RetrievalStatus;
  cards: MemoryCard[];
  answer: string | null;
  memory_summary: string | null;
  memory_uri: MemoryUri | null;
  revision: Revision | null;
  persistence_status: PersistenceStatus;
  navigation_status: NavigationStatus;
  evidence: SourceRef[];
  missing: string[];
  conflicts: string[];
  next_action: string | null;
  continuation_id: string | null;
  budget_used: BudgetUsed;
};
```

`MemoryUri` is always `memory://<store-id>/<memory-id>`. `StoreId` and `MemoryId`
match `[A-Za-z0-9][A-Za-z0-9._~-]*`, so the URI cannot be ambiguous.

## Enforced rules

**Length and counting.** These use Unicode code points, not UTF-16 units, so
astral characters count once.

- Medium body: 500–1000 non-whitespace code points. Whitespace is stripped
  before counting, so padding with whitespace can never reach the 500 floor.
  `body_char_count` must equal the measured count; a padded or inflated declared
  count is rejected. Never pad to reach 500 — the validator cannot read intent,
  but it will not accept a count that hides padding.
- Nav text: 1–200 code points, punctuation and spaces included (whitespace is
  not stripped here). `char_count` must equal the measured count.

**Cross-field identity.**

- `Revision` is an integer of at least 1, for a memory and for every event that
  cites one.
- `state` has three members. `medium_ready` means the medium summary is saved and
  the navigation summary is still pending, so `nav` is null. `published` means
  both are saved, so `nav` is present. `archived` covers a memory retired from
  the active index, whether or not its navigation had been generated, so it
  accepts either. There is no persisted state before the medium summary exists.
- `nav.source_revision` must equal `memory.revision` whenever `nav` exists.
- The memory id inside `uri` must equal `memory_id` (`Memory` and `MemoryCard`).
- `updated_at` must not precede `created_at`.
- `parent_message_id` is the causal parent, never a time neighbour, and a
  message can never be its own parent.
- `RetrievalResult.memory_uri` and `.revision` are present or absent together;
  `persistence_status === "saved"` requires both plus `memory_summary`;
  `status === "not_found"` carries no cards and no `memory_summary`.

**Exhaustive unions.** `MemoryState`, `UsageEventKind`, `UsageChannel`,
`RetrievalStatus`, `PersistenceStatus` and `NavigationStatus` accept only their
declared members. Unknown strings are rejected with `unknown_variant`; nothing is
coerced or defaulted.

**Injection receipts.** Uniqueness key is
`(session,, branch_ref, input_id, memory_id)`; `revision` is deliberately excluded, so
a memory is injected once per source input even after it is revised —
`memory_id` is the stable identity across revisions.
`assertUniqueInjectionReceipts` rejects a duplicate key.

**Usage events.** `event_id` is deterministic from the event's own fields:
SHA-256 over the canonical tuple
`[memory_id, revision, kind, channel, session_id, input_id, at, dedup_key]`.
A retried callback with the same fields yields the same id, so the store can
dedupe on it. `parseUsageEvent` rejects an `event_id` that does not match the
derived value.

## Serialization

`serializeSourceRef` / `deserializeSourceRef` (and the `...Refs` plural forms)
round-trip a `SourceRef` through canonical JSON. The same ref always serializes
to the same bytes; deserializing then re-serializing is a fixed point.

## Boundary parsers

One per boundary type: `parseScope`, `parseSourceRef`, `parseMediumSummary`,
`parseNavSummary`, `parseMemory`, `parseUsageEvent`, `parseInjectionReceipt`,
`parseProjectActivity`, `parseHotspotMembership`, `parseMemoryCard`,
`parseBudgetUsed`, `parseRetrievalResult`, plus the primitives `parseStoreId`,
`parseMemoryId`, `parseMemoryUri`, `parseRevision`, `parseTimestamp` and the
enum parsers `parseMemoryState`, `parseUsageEventKind`, `parseUsageChannel`,
`parseRetrievalStatus`, `parsePersistenceStatus`, `parseNavigationStatus`.

Failures throw `ValidationError` with a JSON-path `path` and a `code`
(`invalid_json`, `invalid_type`, `missing_field`, `unknown_variant`,
`invalid_format`, `out_of_range`, `invariant_violation`).

## Eval fixtures and baseline

- `eval/fixtures/*.jsonl` is the synthetic corpus. Each record has exactly
  `id`, `input` (`text`, `project_id`, `session_id`), `expected` and `why`.
  The `id` prefix is the coverage slug, asserted against `FIXTURE_COVERAGE` in
  `packages/core/src/contracts/fixtures.ts`.
- `eval/baseline/run.mjs` answers a question with no memory and against a
  shell-out `obelisk --search`, writing a ledger (`elapsed_ms`, `bytes`, token
  estimate) under `eval/baseline/out/`. An unavailable Obelisk is reported as
  `not_run` with null resource numbers.

## Not frozen here

Storage layout, the pi extension surface, model choices, hotspot weights and
eviction policy, and the concrete prompt template are later PRs. This document
freezes only the shapes and the boundary rules above.
