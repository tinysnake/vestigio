/**
 * Observability record log (OBS-01).
 *
 * `createObsLog` is the only entry point later PRs need: it returns a writer
 * that validates and appends the five record shapes in `records.ts`, rotates
 * segments and keeps the directory under its byte cap. See `writer.ts` for the
 * failure and retention policy and `validate.ts` for the write-time checks.
 */

export {
	createObsLog,
	DEFAULT_OBS_MAX_BYTES,
	DEFAULT_OBS_SEGMENT_BYTES,
} from "./writer.js";
export type { ObsLog, ObsLogOptions, ObsStream } from "./writer.js";
export { OBS_RECORD_VERSION } from "./records.js";
export type {
	AgentRunContext,
	AgentRunInjection,
	AgentRunOutcome,
	AgentRunRecord,
	AgentRunTokens,
	AgentRunTools,
	IfaceRouteCounts,
	IfaceSnapshotRecord,
	ModelCallOutcome,
	ModelCallPurpose,
	ModelCallRecord,
	ModelCallRequest,
	ModelCallResponse,
	ModelInvocationEndRecord,
	ModelInvocationOutcome,
	ModelInvocationStartRecord,
	ModelUsageTokens,
	ObsRecord,
} from "./records.js";
export { validateObsRecord } from "./validate.js";
export type { ObsRecordParse } from "./validate.js";
