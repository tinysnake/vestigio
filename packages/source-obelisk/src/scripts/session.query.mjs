// Controlled, read-only query template for @vestigio/source-obelisk.
//
// Resolves a session id exactly. The pinned release's `sessions()` resolves an
// exact id with global precedence but also returns up to ten substring
// matches, so the exactness check is the JS filter below, not the query.
// Without this step a missing session and a session with no matching text are
// both "zero hits", which is the ambiguity the adapter refuses to pass on.
const input = __OBELISK_INPUT__;

const rows = sessions({ sessionId: input.session_id, limit: input.lookup_limit });
const exact = rows.filter((entry) => entry.id === input.session_id)[0];

if (exact === undefined) {
  return { found: false, session: null };
}

return {
  found: true,
  session: {
    id: exact.id,
    title: exact.title ?? null,
    project: exact.project ?? null,
    project_path: exact.project_path ?? null,
    started_at: exact.started_at ?? null,
    jsonl_path: exact.jsonl_path ?? null,
    source: exact.source ?? null,
  },
};
