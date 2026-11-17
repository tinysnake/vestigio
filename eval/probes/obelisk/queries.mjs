// Probe: what Obelisk 0.3.0 actually honours in search()/messages().
// Run: HOME=<fixture-home> obelisk --query queries.mjs
// The body runs as an async IIFE inside Obelisk's sandbox; `return` is emitted.
const out = {};

const rows = sql("SELECT uuid, text, visibility, is_meta, cwd, session_id FROM messages ORDER BY timestamp");
out.all_rows = rows;

const find = (needle) => rows.find((r) => String(r.text).includes(needle)) || {};
const a3 = find("second user message");
const hidden = find("hidden marker");
const inactive = find("abandoned branch");
const meta = find("meta envelope");
out.anchor_uuids = { a3: a3.uuid, hidden: hidden.uuid, inactive: inactive.uuid, meta: meta.uuid };
out.anchor_visibilities = {
  a3: a3.visibility, hidden: hidden.visibility, inactive: inactive.visibility, meta_is_meta: meta.is_meta,
};

const brief = (rs) => rs.map((r) => ({
  uuid_tail: String(r.message.uuid).slice(-20),
  text: r.message.text,
  visibility: r.message.visibility,
  project: r.session.project,
  context_len: Array.isArray(r.context) ? r.context.length : null,
}));
const mrow = (m) => (m ? { uuid_tail: String(m.uuid).slice(-20), text: m.text, visibility: m.visibility, is_meta: m.is_meta } : null);
const mwrap = (res) => (res ? { anchor: mrow(res.anchor), messages: res.messages.map(mrow), hasMore: res.hasMore } : null);

// ---- (1) which search options are honoured -------------------------------
out.search_default = brief(search("zqleak"));
out.search_limit_1 = search("zqleak", { limit: 1 }).length;
out.search_sessionId = brief(search("zqleak", { sessionId: a3.session_id }));
out.search_source_pi = search("zqleak", { source: "pi" }).length;
out.search_source_claude = search("zqleak", { source: "claude" }).length;
out.search_after = search("zqleak", { after: "2026-01-01T00:00:02.500Z" }).map((r) => r.message.timestamp);
out.search_before = search("zqleak", { before: "2026-01-01T00:00:02.500Z" }).map((r) => r.message.timestamp);
out.search_includeMeta_false = search("zqleak", { includeMeta: false }).length;
out.search_includeMeta_true = search("zqleak", { includeMeta: true }).length;
out.search_includeInactive_false = brief(search("zqleak", { includeInactive: false }));
out.search_includeInactive_true = brief(search("zqleak", { includeInactive: true }));
out.search_fallback_default = search("zqleak zzznomatchzzz").length;
out.search_fallback_or = search("zqleak zzznomatchzzz", { fallback: "or" }).length;

// Advertised upstream but absent from the 0.3.0 destructure: silently ignored.
out.search_projectPath_ignored = brief(search("zqleak", { projectPath: "/tmp/x-a" }));
out.search_contextLimit_ignored = search("zqleak", { contextLimit: 0 }).map((r) => r.context.length);
out.search_snippetTokens_ignored = search("zqleak", { snippetTokens: 1 }).map((r) => r.message.text);
out.search_unknown_option_ignored = search("zqleak", { totallyUnknownOption: 123 }).length;

// ---- (2) project / cwd filtering is SQL LIKE -----------------------------
// The A project slug is -tmp-x_a; B's is -tmp-x-a. SQLite's LIKE treats `_` as
// a single-character wildcard, so the literal A slug also matches B.
out.project_exact = brief(search("zqleak", { project: "-tmp-x_a" }));
out.project_exact_hit_beta = search("zqleak", { project: "-tmp-x_a" }).some((r) => r.session.project === "-tmp-x-a");
out.cwd_like = brief(search("zqleak", { cwd: "/tmp/x_a" }));
out.cwd_like_hit_other_cwd = search("zqleak", { cwd: "/tmp/x_a" }).some((r) => r.message.cwd === "/tmp/x-a");
out.project_pct_wildcard = brief(search("zqleak", { project: "-tmp-x%" }));
out.project_pct_count = search("zqleak", { project: "-tmp-x%" }).length;

// ---- (3) bounded context + causal parents --------------------------------
out.search_inline_context_lens = search("zqleak").map((r) => r.context.length);
out.messages_uuid = mwrap(messages({ uuid: a3.uuid }));
out.messages_around_timeline = mwrap(messages({ around: a3.uuid, relation: "timeline", beforeCount: 1, afterCount: 1 }));
out.messages_around_parents = mwrap(messages({ around: a3.uuid, relation: "parents", beforeCount: 3 }));
out.messages_around_default = mwrap(messages({ around: a3.uuid }));
let parentsErr = null;
try { messages({ around: a3.uuid, relation: "parents", beforeCount: 3, afterCount: 1 }); }
catch (e) { parentsErr = String(e.message); }
out.messages_parents_with_after_threw = parentsErr;
let capErr = null;
try { messages({ around: a3.uuid, beforeCount: 500 }); }
catch (e) { capErr = String(e.message); }
out.messages_over_500_cap_threw = capErr;
out.search_default_visibilities = [...new Set(search("zqleak").map((r) => r.message.visibility))];

// ---- (4) visibility ------------------------------------------------------
out.messages_hidden_default = mwrap(messages({ uuid: hidden.uuid }));
out.messages_hidden_includeInactive = mwrap(messages({ uuid: hidden.uuid, includeInactive: true }));
out.messages_inactive_default = mwrap(messages({ uuid: inactive.uuid }));
out.messages_inactive_includeInactive = mwrap(messages({ uuid: inactive.uuid, includeInactive: true }));

// ---- unknown options on messages() are strict ----------------------------
let msgErr = null;
try { messages({ around: a3.uuid, totallyUnknownOption: 1 }); }
catch (e) { msgErr = String(e.message); }
out.messages_unknown_option_threw = msgErr;

return out;
