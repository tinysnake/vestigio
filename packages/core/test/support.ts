import type {
  BudgetUsed,
  InjectionReceipt,
  MediumSummary,
  Memory,
  MemoryCard,
  NavSummary,
  RetrievalResult,
  SourceRef,
  UsageEvent,
} from "../src/contracts/index.js";
import { usageEventId } from "../src/contracts/index.js";

/** Independent count so the accept-path tests do not reuse the validator. */
export function measuredNonWhitespace(text: string): number {
  return [...text.replace(/\s/gu, "")].length;
}

export function measuredCodePoints(text: string): number {
  return [...text].length;
}

export function makeSourceRef(overrides: Partial<SourceRef> = {}): SourceRef {
  return {
    provider: "pi",
    source_instance: "local",
    session_id: "s-1",
    message_id: "m-1",
    parent_message_id: null,
    project_id: "p-vestigio",
    timestamp: "2026-11-17T16:21:53Z",
    content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    locator: null,
    ...overrides,
  };
}

export function makeMedium(body = "记".repeat(600), overrides: Partial<MediumSummary> = {}): MediumSummary {
  return {
    body,
    body_char_count: measuredNonWhitespace(body),
    sources: [makeSourceRef()],
    ...overrides,
  };
}

export function makeNav(overrides: Partial<NavSummary> = {}): NavSummary {
  const text = "这条记忆包含部署配置，值得在改端口时读取。";
  return {
    text,
    char_count: measuredCodePoints(text),
    source_revision: 1,
    ...overrides,
  };
}

export function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    memory_id: "mem-0001",
    uri: "memory://vestigio/mem-0001",
    scope: { kind: "project", project_id: "p-vestigio" },
    title: "部署脚本默认端口",
    keywords: ["部署", "端口"],
    revision: 1,
    state: "published",
    medium: makeMedium(),
    nav: makeNav(),
    hit_count: 3,
    access_count: 1,
    last_access_at: "2026-11-17T16:30:00Z",
    created_at: "2026-11-17T16:21:53Z",
    updated_at: "2026-11-17T16:30:00Z",
    ...overrides,
  };
}

export function makeUsageFields(
  overrides: Partial<Omit<UsageEvent, "event_id">> = {},
): Omit<UsageEvent, "event_id"> {
  return {
    memory_id: "mem-0001",
    revision: 1,
    kind: "hit",
    channel: "hotspot",
    session_id: "s-1",
    input_id: "input-1",
    at: "2026-11-17T16:31:00Z",
    dedup_key: "hotspot:p-vestigio:mem-0001:input-1",
    ...overrides,
  };
}

export function makeUsageEvent(overrides: Partial<Omit<UsageEvent, "event_id">> = {}): UsageEvent {
  const fields = makeUsageFields(overrides);
  return { event_id: usageEventId(fields), ...fields };
}

export function makeInjectionReceipt(overrides: Partial<InjectionReceipt> = {}): InjectionReceipt {
  return {
    store_id: "vestigio",
    session_id: "s-1",
    branch_ref: "main",
    input_id: "input-1",
    memory_id: "mem-0001",
    revision: 1,
    committed_at: "2026-11-17T16:32:00Z",
    ...overrides,
  };
}

export function makeMemoryCard(overrides: Partial<MemoryCard> = {}): MemoryCard {
  return {
    memory_id: "mem-0001",
    uri: "memory://vestigio/mem-0001",
    scope: { kind: "global" },
    title: "部署脚本默认端口",
    nav_text: "部署配置与默认端口，改端口前值得读取。",
    revision: 1,
    state: "published",
    score: -1.25,
    hit_count: 3,
    access_count: 1,
    last_access_at: null,
    ...overrides,
  };
}

export function makeBudgetUsed(overrides: Partial<BudgetUsed> = {}): BudgetUsed {
  return {
    elapsed_ms: 12.5,
    model_calls: 1,
    tokens_in: 1200,
    tokens_out: 300,
    cost_usd: null,
    ...overrides,
  };
}

export function makeRetrievalResult(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    status: "resolved",
    cards: [makeMemoryCard()],
    answer: "端口在部署脚本里固定为 8787。",
    memory_summary: "记".repeat(600),
    memory_uri: "memory://vestigio/mem-0001",
    revision: 1,
    persistence_status: "saved",
    navigation_status: "ready",
    evidence: [makeSourceRef()],
    missing: [],
    conflicts: [],
    next_action: null,
    continuation_id: null,
    budget_used: makeBudgetUsed(),
    ...overrides,
  };
}
