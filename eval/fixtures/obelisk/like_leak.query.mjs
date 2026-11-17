// Evidence script, not adapter code: shows the LIKE pattern the adapter refuses
// to use. Same index, same token, same limit as the `--project-path` search in
// build_fixture.sh; the only difference is `project` (a SQL LIKE pattern) instead
// of `projectPath` (exact equality). Run with:
//   HOME=<fixture> node <cli entry> --query eval/fixtures/obelisk/like_leak.query.mjs
return search("zqleak", { project: "-tmp-x_a", limit: 20, contextLimit: 0 }).map((row) => ({
  uuid: row.message.uuid,
  project: row.session.project,
  cwd: row.message.cwd,
}));
