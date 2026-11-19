/**
 * `@vestigio/core/requests` — durable proactive memory requests.
 *
 * Acceptance is a durable, deduped queue row; the slow compose step runs in the
 * background, claims one row under a lease, and writes at most one revision.
 */

export {
  MEMORY_REQUEST_LEASE_MS,
  MEMORY_REQUEST_MAX_ATTEMPTS,
  MEMORY_REQUEST_MAX_EVIDENCE,
  MEMORY_REQUEST_MAX_EXCERPT,
  MEMORY_REQUEST_RETRY_MS,
  claimDueMemoryRequest,
  completeMemoryRequest,
  countMemoryRequests,
  failMemoryRequest,
  insertMemoryRequest,
  listMemoryRequests,
  memoryRequestDedupKey,
  memoryRequestCandidateKey,
  readMemoryRequest,
  readMemoryRequestByDedupKey,
  setMemoryRequestNavigation,
  attachMemoryRequestTarget,
} from "./queue.js";
export type {
  CompleteMemoryRequestInput,
  EnqueueMemoryRequestInput,
  EnqueueMemoryRequestResult,
  MemoryRequest,
  MemoryRequestEvidence,
  MemoryRequestStatus,
} from "./queue.js";
export {
  REQUEST_MAX_CORRECTIONS,
  REQUEST_MAX_OUTPUT_TOKENS,
  REQUEST_MAX_SOURCES,
  composeMemoryRequest,
  requestTitle,
} from "./compose.js";
export type {
  ComposeMemoryRequestInput,
  RequestComposeOutcome,
  RequestComposeStatus,
} from "./compose.js";
