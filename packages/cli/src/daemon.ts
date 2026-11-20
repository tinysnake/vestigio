/**
 * Daemon compatibility surface shared by the CLI and the MCP stdio adapter.
 *
 * Stripe of ownership: the daemon holds scheduling, model calls, memory writes
 * and result delivery; this module only speaks to it through `@vestigio/client`.
 * It keeps the parts that do not need the CLI's flag parser: the client shape
 * both adapters program against, session resolution, and the human-readable
 * formatting of daemon records.
 */
import type { Accepted, Event, Kind, SessionKey, Submission } from "@vestigio/client";

export type { Accepted, Event, Kind, SessionKey, Submission };

/** The three job kinds the daemon schedules; kept in lockstep with its protocol. */
export const DAEMON_KINDS: readonly Kind[] = ["maintenance", "detector", "search"];

/**
 * The slice of `VestigioClient` the adapters use. Tests inject a fake with the
 * same shape, so this stays a plain structural type rather than the class.
 */
export type DaemonClient = {
  session(session: SessionKey): Promise<{ sessionRef: number }>;
  submit(input: Submission): Promise<Accepted>;
  get(jobId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  list(sessionRef: number, after?: string): Promise<unknown>;
  cancel(jobId: string): Promise<{ cancelled: boolean }>;
  receive(sessionRef: number, relay?: boolean): Promise<Event[]>;
  relayed(sessionRef: number, eventIds: string[]): Promise<void>;
  stop(): Promise<boolean>;
};

/**
 * A session is addressed either by the daemon's numeric ref (already known) or
 * by the stable `(source, sessionId)` identity the invoker re-sends to reopen a
 * session. The identity form is resolved lazily, once per command.
 */
export type SessionTarget =
  | { kind: "ref"; sessionRef: number }
  | { kind: "key"; session: SessionKey };

export async function resolveSessionRef(client: DaemonClient, target: SessionTarget): Promise<number> {
  if (target.kind === "ref") return target.sessionRef;
  const { sessionRef } = await client.session(target.session);
  return sessionRef;
}

export type JobPage = {
  jobs: Record<string, unknown>[];
  nextCursor: string | null;
};

/** Read the daemon's `{jobs, nextCursor}` list page without trusting its shape. */
export function readJobPage(value: unknown): JobPage {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const jobs = Array.isArray(record["jobs"])
    ? record["jobs"].filter((job): job is Record<string, unknown> => typeof job === "object" && job !== null)
    : [];
  const nextCursor = typeof record["nextCursor"] === "string" ? record["nextCursor"] : null;
  return { jobs, nextCursor };
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

export function formatJobHuman(job: Record<string, unknown>): string {
  const lines = [
    `job: ${text(job["jobId"])}`,
    `session: ${text(job["sessionRef"])}`,
    `kind: ${text(job["kind"])}  state: ${text(job["state"])}  visibility: ${text(job["visibility"])}`,
  ];
  if (job["resultCode"] !== undefined) {
    lines.push(`result_code: ${text(job["resultCode"])}`);
  }
  if (job["input"] !== undefined) {
    lines.push(`input: ${JSON.stringify(job["input"])}`);
  }
  if (job["result"] !== undefined) {
    lines.push(`result: ${JSON.stringify(job["result"])}`);
  }
  if (job["finishedAt"] !== undefined) {
    lines.push(`finished_at: ${text(job["finishedAt"])}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatJobListHuman(page: JobPage): string {
  const lines = page.jobs.map((job) => {
    const result = job["hasResult"] === true ? " full" : "";
    const code = job["resultCode"] === null || job["resultCode"] === undefined ? "" : ` code=${text(job["resultCode"])}`;
    return `- ${text(job["jobId"])} ${text(job["kind"])} ${text(job["state"])}${result}${code}`;
  });
  lines.push(`next_cursor: ${page.nextCursor ?? "null"}`);
  return `${lines.join("\n")}\n`;
}

export function formatEventHuman(event: Event): string {
  const lines = [
    `event: ${event.eventId}`,
    `job: ${event.jobId}`,
    `kind: ${text(event["kind"])}  state: ${text(event["state"])}  result_code: ${text(event["resultCode"])}`,
  ];
  if (event["result"] !== undefined) {
    lines.push(`result: ${JSON.stringify(event["result"])}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatEventsHuman(events: readonly Event[]): string {
  if (events.length === 0) return "no pending events\n";
  return events.map(formatEventHuman).join("");
}
