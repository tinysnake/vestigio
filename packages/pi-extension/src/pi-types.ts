/**
 * The slice of pi's session manager this extension uses.
 *
 * Pi does not re-export `ReadonlySessionManager` from its package entry, so the
 * type is derived from the context it hands every handler. That keeps the
 * extension pinned to whatever pi actually passes instead of to a name that may
 * or may not be public.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SessionManagerLike = ExtensionContext["sessionManager"];

export type SessionTreeLike = Pick<SessionManagerLike, "getBranch" | "getSessionId">;
