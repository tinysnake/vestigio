/**
 * Cooperative deadline for the hotspot match path.
 *
 * Plan §9 makes the 1 second ceiling a hard product requirement: the local
 * index read, the render and the append must finish inside it, and a timeout
 * must abandon THIS turn's injection, record a reason and never block the
 * user's input. A synchronous SQLite read cannot be interrupted from the same
 * thread, so the deadline is cooperative: every store read on the hotspot path
 * is followed by `check()`. The store is also opened with a short busy timeout,
 * which bounds the one blocking case (a write lock) from the other side.
 */

export class HotspotTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HotspotTimeoutError";
  }
}

export class Deadline {
  readonly timeout_ms: number;
  private readonly now: () => number;
  private readonly started_at: number;

  constructor(timeoutMs: number, now: () => number = () => performance.now()) {
    this.timeout_ms = timeoutMs;
    this.now = now;
    this.started_at = now();
  }

  get elapsed_ms(): number {
    return this.now() - this.started_at;
  }

  get expired(): boolean {
    return this.elapsed_ms >= this.timeout_ms;
  }

  /** Throws `HotspotTimeoutError` once the ceiling is reached. */
  check(stage: string): void {
    const elapsed = this.elapsed_ms;
    if (elapsed >= this.timeout_ms) {
      throw new HotspotTimeoutError(
        `hotspot match exceeded ${this.timeout_ms}ms at ${stage} (${elapsed.toFixed(1)}ms)`,
      );
    }
  }
}
