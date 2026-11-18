import type {
  FreshnessBrief,
  HotspotMembership,
  InjectionReceipt,
  Memory,
  MemoryId,
  MemoryState,
  MemoryUri,
  ProjectActivity,
  Revision,
  UsageEvent,
} from "../../src/contracts/index.js";
import type { HotspotStore } from "../../src/hotspots/index.js";
import { openStore, type MemoryStore } from "../../src/storage/index.js";
import { bodyWith, navWith, storedMemory, tempDbPath } from "../storage/support.js";

export const PROJECT = "p-vestigio";
export const NOW = "2026-11-17T18:00:00Z";

export function newStore(): MemoryStore {
  return openStore({ path: tempDbPath("hotspot") });
}

export type SeedInput = {
  memory_id: string;
  title?: string;
  keywords?: string[];
  nav?: string;
  body?: string;
  state?: MemoryState;
  revision?: number;
  hit_count?: number;
  access_count?: number;
  last_access_at?: string | null;
  admitted_seq?: number;
  project_id?: string;
  /** Skip the membership row (default false: seeded memories are pooled). */
  pooled?: boolean;
};

/** Save a published memory and (by default) add it to its project pool. */
export function seedMemory(store: MemoryStore, input: SeedInput): Memory {
  const projectId = input.project_id ?? PROJECT;
  const revision = input.revision ?? 1;
  const title = input.title ?? "部署脚本默认端口";
  const memory = storedMemory({
    body: input.body ?? bodyWith(`${title}：部署步骤与回滚方式说明。`),
    memory_id: input.memory_id,
    title,
    keywords: input.keywords ?? ["部署", "端口"],
    nav: navWith(input.nav ?? "这条记忆包含部署配置和默认端口，改端口时值得读取。", revision),
    state: input.state ?? "published",
    scope: { kind: "project", project_id: projectId },
    revision,
    hit_count: input.hit_count ?? 0,
    access_count: input.access_count ?? 0,
    last_access_at: input.last_access_at ?? null,
    created_at: NOW,
    updated_at: NOW,
  });
  store.saveMemory(memory);
  const stored = store.readMemory(memory.uri);
  if (stored === null) {
    throw new Error(`seedMemory failed to store ${memory.memory_id}`);
  }
  if (input.pooled !== false) {
    store.upsertHotspotMembership({
      project_id: projectId,
      memory_id: input.memory_id,
      admitted_seq: input.admitted_seq ?? 1,
      last_hit_seq: 0,
      last_access_seq: 0,
      recent_hit_weight: 0,
      recent_access_weight: 0,
    });
  }
  return stored;
}

export function setActivity(store: MemoryStore, projectId: string, activitySeq: number): void {
  store.upsertProjectActivity({
    project_id: projectId,
    activity_seq: activitySeq,
    last_input_at: NOW,
  });
}

/** A structural fake so tests can inject latency and failures deterministically. */
export class FakeStore implements HotspotStore {
  readonly storeId = "vestigio";
  readonly memories = new Map<string, Memory>();
  readonly memberships = new Map<string, HotspotMembership[]>();
  readonly activity = new Map<string, ProjectActivity>();
  readonly usage: UsageEvent[] = [];
  readonly receipts: InjectionReceipt[] = [];
  /** Called before every `readMemory`, after the clock is read. */
  onReadMemory: (() => void) | null = null;
  receiptError: Error | null = null;
  readonly freshness = new Map<MemoryId, FreshnessBrief>();

  readProjectActivity(projectId: string): ProjectActivity | null {
    return this.activity.get(projectId) ?? null;
  }

  readFreshness(uri: MemoryUri): FreshnessBrief | null {
    const memory = this.memories.get(uri);
    if (memory === undefined) {
      return null;
    }
    return (
      this.freshness.get(memory.memory_id) ?? {
        is_stale: false,
        head_revision: memory.revision,
        pending_count: 0,
        freshness_sig: "",
      }
    );
  }

  readHotspotMemberships(projectId: string): HotspotMembership[] {
    return this.memberships.get(projectId) ?? [];
  }

  readMemory(uri: MemoryUri): Memory | null {
    this.onReadMemory?.();
    return this.memories.get(uri) ?? null;
  }

  recordUsageEvent(event: UsageEvent): boolean {
    const duplicate = this.usage.some((it) => it.event_id === event.event_id);
    if (duplicate) {
      return false;
    }
    this.usage.push(event);
    return true;
  }

  recordInjectionReceipt(receipt: InjectionReceipt, _options?: { freshness_sig?: string }): void {
    if (this.receiptError !== null) {
      throw this.receiptError;
    }
    const exists = this.receipts.some(
      (it) =>
        it.session_id === receipt.session_id &&
        it.branch_ref === receipt.branch_ref &&
        it.input_id === receipt.input_id &&
        it.memory_id === receipt.memory_id,
    );
    if (exists) {
      throw new Error("duplicate_injection_receipt");
    }
    this.receipts.push(receipt);
  }

  upsertProjectActivity(activity: ProjectActivity): ProjectActivity {
    const existing = this.activity.get(activity.project_id);
    const next =
      existing === undefined || activity.activity_seq > existing.activity_seq ? activity : existing;
    this.activity.set(activity.project_id, next);
    return next;
  }

  upsertHotspotMembership(membership: HotspotMembership): void {
    const rows = this.memberships.get(membership.project_id) ?? [];
    const index = rows.findIndex((row) => row.memory_id === membership.memory_id);
    if (index === -1) {
      this.memberships.set(membership.project_id, [...rows, membership]);
      return;
    }
    const copy = [...rows];
    copy[index] = membership;
    this.memberships.set(membership.project_id, copy);
  }

  deleteHotspotMembership(projectId: string, memoryId: MemoryId): void {
    const rows = this.memberships.get(projectId) ?? [];
    this.memberships.set(
      projectId,
      rows.filter((row) => row.memory_id !== memoryId),
    );
  }
}

export type { MemoryId, Revision };

import type { HotspotEntry, HotspotMatch } from "../../src/hotspots/index.js";
import { makeMemory } from "../support.js";

/** A `Memory` whose URI is derived from its id, which `makeMemory` does not do. */
export function makeFakeMemory(overrides: Partial<Memory> = {}): Memory {
  const memory_id = overrides.memory_id ?? "mem-0001";
  return makeMemory({ uri: `memory://vestigio/${memory_id}`, ...overrides });
}

export function makeEntry(overrides: Partial<HotspotEntry> = {}): HotspotEntry {
  const memory_id = overrides.memory_id ?? "mem-0001";
  const nav = overrides.nav ?? navWith(overrides.nav_text ?? "部署配置与默认端口，改端口前值得读取。", 1);
  return {
    memory_id,
    uri: `memory://vestigio/${memory_id}`,
    title: "部署脚本默认端口",
    keywords: ["部署", "端口"],
    nav,
    nav_text: nav.text,
    revision: 1,
    state: "published",
    scope: { kind: "project", project_id: PROJECT },
    source_label: "pi/local",
    source_count: 1,
    hit_count: 0,
    access_count: 0,
    last_access_at: null,
    admitted_seq: 1,
    last_hit_seq: 0,
    last_access_seq: 0,
    recent_hit_weight: 0,
    recent_access_weight: 0,
    freshness: { is_stale: false, head_revision: 1, pending_count: 0, freshness_sig: "" },
    ...overrides,
  };
}

export function makeMatch(overrides: Partial<HotspotMatch> = {}): HotspotMatch {
  const memory_id = overrides.memory_id ?? "mem-0001";
  return {
    memory_id,
    uri: `memory://vestigio/${memory_id}`,
    title: "部署脚本默认端口",
    nav_text: "部署配置与默认端口，改端口前值得读取。",
    revision: 1,
    keywords: ["部署", "端口"],
    source_label: "pi/local",
    source_count: 1,
    score: 2,
    specificity: 0.5,
    matched_tokens: ["部署", "端口"],
    phrase_matched: false,
    retention_score: 1,
    freshness: { is_stale: false, head_revision: 1, pending_count: 0, freshness_sig: "" },
    ...overrides,
  };
}
