/**
 * Shared extension state: the opened store, the current branch's injection
 * ledger, the session identity and the lazily created history port.
 *
 * Everything here is best-effort. Opening the store, reading the branch or
 * creating the history port can fail for reasons that have nothing to do with
 * the user's turn (missing file, locked db, no Obelisk home), and a broken
 * memory layer must never block input or a tool call.
 */

import type { HistoryPort } from "@vestigio/core/retrieval";
import type { ModelPort, ResolveContinuation } from "@vestigio/core/resolver";
import { openStore } from "@vestigio/core/storage";
import type { MemoryStore } from "@vestigio/core/storage";
import { resolveProjectId } from "@vestigio/core/project";
import type { InjectionLedgerDelta } from "@vestigio/core/hotspots";
import { InjectionLedger } from "@vestigio/core/hotspots";
import type { VestigioConfig } from "./config.js";
import { DecisionLog, type DecisionRecord } from "./decision-log.js";
import { loadLedger } from "./ledger-store.js";
import { createObeliskHistoryPort } from "@vestigio/source-obelisk";
import { createAgentModelPort, createOpenAiCompatibleClient } from "@vestigio/model-client";
import type { OpenAiCompatibleOptions } from "@vestigio/model-client";
import type { SessionManagerLike, SessionTreeLike } from "./pi-types.js";

export type SessionLike = SessionTreeLike;

/** The one seam a test needs: open a store the caller controls. */
export type StateDeps = {
	open?: (options: { path: string }) => MemoryStore;
	/** Replaces the OpenAI-compatible client in tests. */
	create_model?: (options: OpenAiCompatibleOptions) => ModelPort;
	create_history?: () => HistoryPort;
};

export function sessionProjectId(config: VestigioConfig, dir: string): string {
	return resolveProjectId(config.project_id ?? dir);
}

export class VestigioState {
	readonly config: VestigioConfig;
	readonly log: DecisionLog;

	private store: MemoryStore | null = null;
	private readonly open: (options: { path: string }) => MemoryStore;
	private readonly createModel: (options: OpenAiCompatibleOptions) => ModelPort;
	private readonly createHistory: (() => HistoryPort) | null;
	private storeFailure: string | null = null;
	private ledger: InjectionLedger = new InjectionLedger();
	private history: HistoryPort | null = null;
	private historyFailure: string | null = null;
	private model: ModelPort | null = null;
	private modelFailure: string | null = null;
	private modelAttempted = false;
	private resolves = 0;
	private continuation: ResolveContinuation | null = null;
	private turn = 0;
	private sessionId = "unknown";
	private branchRef = "root";
	private sessionManager: SessionLike | null = null;
	private readonly seen: Set<string> = new Set();
	private readonly backgroundAttempts: Map<string, number> = new Map();
	private detectorCheckpoint: string | null = null;
	private userInput: { text: string } | null = null;

	constructor(config: VestigioConfig, log?: DecisionLog, deps: StateDeps = {}) {
		this.config = config;
		this.log = log ?? new DecisionLog(config.decision_log);
		this.open = deps.open ?? openStore;
		this.createModel = deps.create_model ?? createOpenAiCompatibleClient;
		this.createHistory = deps.create_history ?? null;
	}

	/** Open the store once. Returns null (and logs once) when it cannot open. */
	ensureStore(): MemoryStore | null {
		if (this.store !== null) return this.store;
		const path = this.config.store_path;
		if (path === null) return null;
		try {
			this.store = this.open({ path });
			return this.store;
		} catch (error) {
			this.storeFailure = errorText(error);
			this.log.write({ ts: nowIso(), kind: "error", status: "store_unavailable", error: this.storeFailure });
			return null;
		}
	}

	get currentStore(): MemoryStore | null {
		return this.store;
	}

	get currentLedger(): InjectionLedger {
		return this.ledger;
	}

	get currentSessionId(): string {
		return this.sessionId;
	}

	get currentBranchRef(): string {
		return this.branchRef;
	}

	get storeFailureReason(): string | null {
		return this.storeFailure;
	}

	/**
	 * Rebind to a session or a moved branch. The ledger is rebuilt from the
	 * branch, which is what makes fork inherit and revert forget. The detector
	 * checkpoint and the seen-memory set are per session, so they reset here.
	 */
	bindSession(sessionManager: SessionLike): void {
		this.sessionManager = sessionManager;
		try {
			this.sessionId = sessionManager.getSessionId();
		} catch {
			this.sessionId = "unknown";
		}
		this.branchRef = branchRefFor(sessionManager);
		this.detectorCheckpoint = null;
		try {
			const branch = sessionManager.getBranch();
			const ids = new Set(branch.map((entry) => entry.id));
			for (const entry of branch) {
				if (entry.type === "custom" && entry.customType === "vestigio.detector-checkpoint" && typeof entry.data === "object" && entry.data !== null && "entry_id" in entry.data && typeof entry.data.entry_id === "string" && ids.has(entry.data.entry_id)) {
					this.detectorCheckpoint = entry.data.entry_id;
				}
			}
		} catch {
			this.detectorCheckpoint = null;
		}
		this.seen.clear();
		this.backgroundAttempts.clear();
		try {
			this.ledger = loadLedger(sessionManager);
		} catch {
			this.ledger = new InjectionLedger();
		}
		this.ensureStore();
		this.log.write({
			ts: nowIso(),
			kind: "session",
			status: "bound",
			session_id: this.sessionId,
			branch_ref: this.branchRef,
			ledger_added: this.ledger.size,
		});
	}

	projectId(cwd: string): string {
		return sessionProjectId(this.config, cwd);
	}

	/**
	 * The directory the history source indexed this session under. Memories scope
	 * by the repository root, but the history index records the directory a
	 * session actually ran in, and an explicit project id names that directory.
	 */
	historyPath(cwd: string): string {
		return this.config.project_id ?? cwd;
	}

	get sessionManagerRef(): SessionLike | null {
		return this.sessionManager;
	}

	/**
	 * Remember a memory the agent saw this session (search card, read or
	 * resolve). The `agent_end` detector only inspects memories the agent
	 * actually met, plus whatever the store already flags as pending.
	 */
	noteMemorySeen(memoryId: string): void {
		this.seen.add(memoryId);
	}

	seenMemoryIds(): string[] {
		return [...this.seen];
	}

	/**
	 * How many times the background pass has tried this exact pending set in
	 * this session. The pass reads the count to cap its own retries and to
	 * report a memory it can no longer attempt instead of dropping it.
	 */
	backgroundAttemptsFor(signature: string): number {
		return this.backgroundAttempts.get(signature) ?? 0;
	}

	noteBackgroundAttempt(signature: string): void {
		this.backgroundAttempts.set(signature, this.backgroundAttemptsFor(signature) + 1);
	}

	/** The last entry the detector inspected, so a turn is judged once. */
	get detectorCheckpointId(): string | null {
		return this.detectorCheckpoint;
	}

	advanceDetectorCheckpoint(entryId: string | null): void {
		this.detectorCheckpoint = entryId;
	}

	/**
	 * The real input this turn is answering. The request tool classifies this
	 * text to refuse a temporary or negated save; there is no code-enforced
	 * confirmation and no model-supplied confirmation flag.
	 */
	noteUserInput(text: string): void {
		this.userInput = text.trim().length === 0 ? null : { text };
	}

	get currentUserInput(): { text: string } | null {
		return this.userInput;
	}

	clearUserInput(): void {
		this.userInput = null;
	}

	/** Monotonic per-session turn counter; unique even for same-millisecond input. */
	nextInputId(): string {
		this.turn += 1;
		return `${this.sessionId}#${this.turn}#${Date.now().toString(36)}`;
	}

	/**
	 * The history port, created on first use. Only the read-only Obelisk
	 * adapter is wired here; an absent `VESTIGIO_OBELISK_HOME` means the
	 * history layer is simply not available, which `layeredSearch` reports.
	 */
	async historyPort(): Promise<HistoryPort | null> {
		if (this.history !== null) return this.history;
		if (this.historyFailure !== null) return null;
		try {
			if (this.createHistory !== null) {
				this.history = this.createHistory();
				return this.history;
			}
			const home = this.config.obelisk_home;
			if (home === null) return null;
			this.history = createObeliskHistoryPort({
				home,
				cli_path: this.config.obelisk_cli ?? undefined,
			});
			return this.history;
		} catch (error) {
			this.historyFailure = errorText(error);
			this.log.write({ ts: nowIso(), kind: "error", status: "history_unavailable", error: this.historyFailure });
			return null;
		}
	}

	historySkipReason(): string | null {
		if (this.config.obelisk_home === null) return "VESTIGIO_OBELISK_HOME is not configured";
		if (this.historyFailure !== null) return `history layer unavailable: ${this.historyFailure}`;
		return null;
	}

	/**
	 * The model port, created on first use. Without `VESTIGIO_MODEL_BASE_URL`
	 * there is no configured backend, and `memory_resolve` degrades to the
	 * zero-LLM layered search with a stated reason — it never silently picks
	 * another endpoint.
	 */
	modelPort(): ModelPort | null {
		if (this.config.model_base_url === null) return null;
		if (this.model !== null) return this.model;
		if (this.modelAttempted) return null;
		this.modelAttempted = true;
		try {
			this.model = createAgentModelPort(
				{
					base_url: this.config.model_base_url,
					model: this.config.model_id,
					api_key: this.config.model_api_key ?? undefined,
					thinking: this.config.model_thinking,
				},
				this.config.agent_models,
				(options) => this.createModel(options),
			);
			return this.model;
		} catch (error) {
			this.modelFailure = errorText(error);
			this.log.write({ ts: nowIso(), kind: "error", status: "model_unavailable", error: this.modelFailure });
			return null;
		}
	}

	modelSkipReason(): string | null {
		if (this.config.model_base_url === null) return "VESTIGIO_MODEL_BASE_URL is not configured";
		if (this.modelFailure !== null) return `model unavailable: ${this.modelFailure}`;
		return null;
	}

	/** Resolves already attempted in this Session; the resolver enforces the cap. */
	resolveCountUsed(): number {
		return this.resolves;
	}

	noteResolveUsed(): void {
		this.resolves += 1;
	}

	/** The last reusable candidate set; the resolver re-checks scope, question and expiry. */
	get lastContinuation(): ResolveContinuation | null {
		return this.continuation;
	}

	set lastContinuation(value: ResolveContinuation | null) {
		this.continuation = value;
	}

	recordDelta(delta: InjectionLedgerDelta, host: { appendEntry<T>(customType: string, data?: T): void }): void {
		if (delta.memory_ids.length === 0) return;
		try {
			host.appendEntry("vestigio.injection-ledger", delta);
		} catch (error) {
			this.log.write({ ts: nowIso(), kind: "error", status: "ledger_persist_failed", error: errorText(error) });
		}
	}

	writeDecision(record: DecisionRecord): void {
		this.log.write(record);
	}

	close(): void {
		if (this.store === null) return;
		try {
			this.store.close();
		} catch {
			// closing at shutdown is best-effort
		}
	}
}

/**
 * The branch's identity: the id of its root entry, which stays the same for
 * every turn on the branch. `getBranch()` returns the branch root-first, so the
 * root is the first element; taking the last one would pin the leaf and change
 * the identity every turn.
 */
export function branchRefFor(sessionManager: Pick<SessionManagerLike, "getBranch">): string {
	try {
		const branch = sessionManager.getBranch();
		return branch[0]?.id ?? "root";
	} catch {
		return "root";
	}
}

export function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function nowIso(): string {
	return new Date().toISOString();
}
