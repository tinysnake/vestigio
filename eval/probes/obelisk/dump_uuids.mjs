// Dump every indexed message uuid and the readable provenance path for each
// session. Used to compare identity across a rebuild and a move of the source.
// Run: HOME=<fixture-home> obelisk --query dump_uuids.mjs
return {
  messages: sql("SELECT uuid, session_id, text FROM messages ORDER BY uuid"),
  sessions: sql("SELECT id, title, project, project_path, jsonl_path FROM sessions ORDER BY id"),
};
