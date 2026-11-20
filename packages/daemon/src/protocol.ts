export const PROTOCOL_VERSION = 1;
export const KINDS = ["maintenance", "detector", "search"] as const;
export type Kind = typeof KINDS[number];
export type SessionKey = { source: string; sessionId: string };
export type Endpoint = { version: number; instanceId: string; port: number; token: string };

export type Submission = {
	session: SessionKey;
	requestId: string;
	kind: Kind;
	input: unknown;
};

export type Accepted = { jobId: string; sessionRef: number };
export type Event = { eventId: string; jobId: string } & Record<string, unknown>;

export function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Expected a JSON object");
	}
	return value as Record<string, unknown>;
}

export function identifier(value: unknown, label: string, max = 256): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) {
		throw new TypeError(`Invalid ${label}`);
	}
	return value;
}

export function sessionKey(value: unknown): SessionKey {
	const session = object(value);
	return { source: identifier(session.source, "source", 64), sessionId: identifier(session.sessionId, "sessionId") };
}

export function submission(value: unknown): Submission {
	const data = object(value);
	const kind = KINDS.find((candidate) => candidate === data.kind);
	if (!kind || !("input" in data)) throw new TypeError("Expected a job kind and input");
	return { session: sessionKey(data.session), requestId: identifier(data.requestId, "requestId"), kind, input: data.input };
}
