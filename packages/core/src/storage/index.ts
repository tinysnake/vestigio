export { StorageError, isUniqueViolation } from "./errors.js";
export type { StorageErrorCode } from "./errors.js";
export { applyMigrations, listAppliedMigrations, MIGRATIONS } from "./migrations.js";
export type { AppliedMigration, Migration } from "./migrations.js";
export { buildMatchQuery, normalizeForIndex } from "./tokenize.js";
export type { MatchMode } from "./tokenize.js";
export { DEFAULT_BUSY_TIMEOUT_MS, DEFAULT_STORE_ID, MemoryStore, openStore } from "./store.js";
export type {
  IntegrityReport,
  OpenStoreOptions,
  SaveMemoryOptions,
  SaveMemoryResult,
  SearchHit,
  SearchOptions,
} from "./store.js";
