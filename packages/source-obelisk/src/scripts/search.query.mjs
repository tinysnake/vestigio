// Controlled, read-only query template for @vestigio/source-obelisk.
//
// The adapter substitutes the single input token with one JSON
// literal and nothing else. Every value below reaches the tool as a bound
// parameter or an option value; no caller string is ever spliced into code or
// SQL. The only SQL here is a constant SELECT.
//
// Returns the search hits plus, per hit, the causal parent and the source file,
// which the `--search` CLI path does not expose.
const input = __OBELISK_INPUT__;

const searchOptions = {
  limit: input.limit,
  contextLimit: input.context_limit,
  includeMeta: input.include_meta,
  includeInactive: input.include_inactive,
};
if (input.project_path !== null) searchOptions.projectPath = input.project_path;
if (input.session_id !== null) searchOptions.sessionId = input.session_id;
if (input.after !== null) searchOptions.after = input.after;
if (input.before !== null) searchOptions.before = input.before;
if (input.source !== null) searchOptions.source = input.source;

const rows = search(input.text, searchOptions);

const hits = rows.map((row) => {
  const meta = sql(
    "SELECT m.parent_uuid AS parent_uuid, s.jsonl_path AS jsonl_path, s.project_path AS project_path " +
      "FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.uuid = ?",
    row.message.uuid,
  )[0];
  return {
    message: row.message,
    session: row.session,
    rank: row.rank,
    context: row.context,
    parent_uuid: meta ? meta.parent_uuid : null,
    jsonl_path: meta ? meta.jsonl_path : null,
    project_path: meta ? meta.project_path : null,
  };
});

let sessionFound = null;
if (input.session_id !== null) {
  const known = sessions({ sessionId: input.session_id, limit: input.session_lookup_limit });
  sessionFound = known.some((entry) => entry.id === input.session_id);
}

return { hits, session_found: sessionFound };
