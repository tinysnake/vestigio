// Controlled, read-only query template for @vestigio/source-obelisk.
//
// One bounded `messages()` window: the anchor plus at most `before_count`
// predecessors and `after_count` successors. The adapter rejects a window over
// 500 (the pinned release's cap) and rejects `after_count !== 0` for the
// causal-parent relation before this script is ever written.
//
// `messages()` returns `null` for an anchor that is missing, hidden, or
// inactive without `includeInactive` — the adapter turns that into a typed
// failure rather than an empty page.
//
// A forward-only timeline window is paged with a cursor instead of `around`.
// `around` binds `agent_id IS ?`, which makes SQLite pick `idx_messages_agent`
// over the session index and scan nearly every message in the index (measured
// 46 s on a 1.2M-row index). Resolving the anchor and paging from it stays on
// `idx_messages_session` (measured 0 ms) and returns the same successors. The
// anchor row is put back first because the adapter requires it in the window.
const input = __OBELISK_INPUT__;

if (input.relation === "timeline" && input.before_count === 0 && input.after_count > 0) {
  const anchorPage = messages({
    uuid: input.anchor,
    includeInactive: input.include_inactive,
    includeSession: true,
  });
  if (anchorPage === null || anchorPage === undefined) {
    return { found: false };
  }
  const anchor = anchorPage.anchor;
  const forward = messages({
    sessionId: anchor.session_id,
    cursor: { timestamp: anchor.timestamp, uuid: anchor.uuid },
    limit: input.after_count,
    includeInactive: input.include_inactive,
    includeSession: true,
  });
  return {
    found: true,
    anchor,
    messages: [anchor, ...forward.messages],
    session: forward.session ?? anchorPage.session ?? null,
    has_more: forward.hasMore === true,
    next_cursor: forward.nextCursor ?? null,
  };
}

const page = messages({
  around: input.anchor,
  relation: input.relation,
  beforeCount: input.before_count,
  afterCount: input.after_count,
  includeInactive: input.include_inactive,
  includeSession: true,
});

if (page === null || page === undefined) {
  return { found: false };
}

return {
  found: true,
  anchor: page.anchor,
  messages: page.messages,
  session: page.session ?? null,
  has_more: page.hasMore === true,
  next_cursor: page.nextCursor ?? null,
};
