/**
 * Typed retrieval failures. The layered search degrades environment problems to
 * reported layer statuses; it throws only when the caller's own options cannot
 * be honoured, which is the same loud-error rule the rest of the repo uses.
 */

export type RetrievalErrorCode =
  /** A malformed query or scope. */
  | "invalid_option"
  /** A cap was requested outside its allowed range. */
  | "limit_out_of_range";

export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;

  constructor(code: RetrievalErrorCode, message: string) {
    super(message);
    this.name = "RetrievalError";
    this.code = code;
  }
}

export function retrievalError(code: RetrievalErrorCode, message: string): RetrievalError {
  return new RetrievalError(code, message);
}

export function isRetrievalError(value: unknown): value is RetrievalError {
  return value instanceof RetrievalError;
}
