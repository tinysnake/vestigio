// Evidence script, not adapter code. Lists the fixture's rows straight from the
// index so the live suite can prove what the CLI stores (visibility, is_meta,
// parent chain) independently of what search() returns. Run with:
//   HOME=<fixture> node <cli entry> --query eval/fixtures/obelisk/evidence_rows.query.mjs
return sql(
  "SELECT uuid, session_id, parent_uuid, text, visibility, is_meta FROM messages ORDER BY session_id, timestamp",
).map((row) => ({
  uuid: row.uuid,
  session_id: row.session_id,
  parent_uuid: row.parent_uuid,
  text: row.text,
  visibility: row.visibility,
  is_meta: row.is_meta,
}));
