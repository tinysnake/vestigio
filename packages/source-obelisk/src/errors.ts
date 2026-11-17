/**
 * Typed failures. Every condition the adapter can meet at the Obelisk boundary
 * has its own `kind`, so callers never have to read a message string and never
 * have to treat "no results" as a failure mode: an empty result is a successful
 * call with zero hits, and an unavailable Obelisk throws `unavailable`.
 */

export type ObeliskErrorKind =
  /** The pinned CLI artifact cannot be found or started. */
  | "unavailable"
  /** The isolated data directory has no index (`<home>/.obelisk/obelisk.sqlite`). */
  | "index_missing"
  /** The installed artifact is not the pinned release. */
  | "version_mismatch"
  /** An option this release cannot honour, or one the adapter refuses on purpose. */
  | "unsupported_option"
  /** A malformed value (range, type, non-absolute path). */
  | "invalid_option"
  /** A `session_id` filter names a session this index does not contain. */
  | "session_not_found"
  /** The anchor is absent, hidden, or inactive without `include_inactive`. */
  | "message_not_visible"
  /** The child exited non-zero, or printed `{ error }`. */
  | "cli_error"
  /** The child exceeded its deadline and was killed. */
  | "cli_timeout"
  /** The caller aborted and the child was killed. */
  | "cli_cancelled"
  /** The child printed something that is not the pinned release's shape. */
  | "protocol"
  /** A hit escaped the requested project: the filter was ignored or not exact. */
  | "project_scope";

export type ObeliskErrorDetail = {
  /** Present for CLI failures: process exit code. */
  readonly exit_code?: number;
  /** Present for CLI failures: captured stderr, trimmed. */
  readonly stderr?: string;
  /** Present for option failures: the offending option path. */
  readonly option?: string;
  /** Present for protocol failures: what was expected. */
  readonly expected?: string;
};

export class ObeliskError extends Error {
  readonly kind: ObeliskErrorKind;
  readonly detail: ObeliskErrorDetail;

  constructor(kind: ObeliskErrorKind, message: string, detail: ObeliskErrorDetail = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "ObeliskError";
    this.kind = kind;
    this.detail = detail;
  }
}

export function obeliskError(
  kind: ObeliskErrorKind,
  message: string,
  detail: ObeliskErrorDetail = {},
  options?: ErrorOptions,
): ObeliskError {
  return new ObeliskError(kind, message, detail, options);
}

export function isObeliskError(value: unknown): value is ObeliskError {
  return value instanceof ObeliskError;
}

/** The kinds that mean "the source is not there", as opposed to "the call failed". */
export const UNAVAILABLE_KINDS = ["unavailable", "index_missing", "version_mismatch"] as const;

export function isUnavailable(error: unknown): boolean {
  return isObeliskError(error) && (UNAVAILABLE_KINDS as readonly string[]).includes(error.kind);
}
