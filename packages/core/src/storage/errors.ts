/** Errors raised by the storage layer, distinct from contract ValidationError. */
export type StorageErrorCode =
  | "store_mismatch"
  | "store_identity_mismatch"
  | "first_revision_not_one"
  | "stale_revision"
  | "nav_revision_mismatch"
  | "uri_content_changed"
  | "created_at_mismatch"
  | "not_found"
  | "duplicate_injection_receipt"
  | "row_corrupt"
  | "closed";

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "StorageError";
    this.code = code;
  }
}

/** True for a SQLite uniqueness violation, which callers translate to a typed error. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
