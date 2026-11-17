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
import { openStore } from "@vestigio/core/storage";
import type { MemoryStore } from "@vestigio/core/storage";
import type { InjectionLedgerDelta } from "@vestigio/core/hotspots";
import { InjectionLedger } from "@vestigio/core/hotspots";
import type { VestigioConfig } from "./config.js";
import { DecisionLog, type DecisionRecord } from "./decision-log.js";
import { loadLedger } from "./ledger-store.js";
import { createObeliskHistoryPort } from "@vestigio/source-obelisk";
import type { SessionManagerLike, SessionTreeLike } from "./pi-types.js";

export type SessionLike = SessionTreeLike;

/** The one seam a test needs: open a store the caller controls. */
export type StateDeps = {
	open?: (options: { path: string }) => MemoryStore;
};

export class VestigioState {
	readonly config: VestigioConfig;
	readonly log: DecisionLog;

	private store: MemoryStore | null = null;
	private readonly open: (options: { path: string }) => MemoryStore;
	private storeFailure: string | null = null;
	private ledger: InjectionLedger = new InjectionLedger();
	private history: HistoryPort | null = null;
	private historyFailure: string | null = null;
	private turn = 0;
	private sessionId = "unknown";
	private branchRef = "root";

	constructor(config: VestigioConfig, log?: DecisionLog, deps: StateDeps = {}) {
		this.config = config;
		this.log = log ?? new DecisionLog(config.decision_log);
		this.open = deps.open ?? openStore;
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
	 * branch, which is what makes fork inherit and revert forget.
	 */
	bindSession(sessionManager: SessionLike): void {
		try {
			this.sessionId = sessionManager.getSessionId();
		} catch {
			this.sessionId = "unknown";
		}
		this.branchRef = branchRefFor(sessionManager);
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
		return this.config.project_id ?? cwd;
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
		if (this.config.obelisk_home === null) return null;
		if (this.history !== null) return this.history;
		if (this.historyFailure !== null) return null;
		try {
			this.history = createObeliskHistoryPort({
				home: this.config.obelisk_home,
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
		if (this.config.obelisk_home === null) return `未配置 ${"VESTIGIO_OBELISK_HOME"}`;
		if (this.historyFailure !== null) return `历史层不可用：${this.historyFailure}`;
		return null;
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
