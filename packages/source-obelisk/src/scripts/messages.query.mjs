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
const input = __OBELISK_INPUT__;

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
