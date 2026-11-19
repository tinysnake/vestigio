/**
 * Shared fixtures for the PR-07 tests: a body builder that can hit an exact
 * non-whitespace length, and a scripted chat port that routes by the system
 * prompt so one port can serve the judge, the medium summary and the nav.
 */

import type { ModelPort, ModelRequest, ModelResult } from "../../src/resolver/index.js";

const FILLER = "部署脚本默认端口是8787，回滚时恢复旧配置并复跑一遍检查。";

export function nonWhitespace(text: string): number {
  return [...text].filter((point) => !/\s/u.test(point)).length;
}

/** A body of exactly `n` non-whitespace points, ending in one citation. */
export function bodyOfLength(n: number, citationId = "h-1"): string {
  const citation = `[来源:${citationId}]`;
  const pad = n - [...citation].length;
  if (pad < 1) throw new Error(`cannot build a ${n}-point body around ${citation}`);
  const filler = FILLER.repeat(Math.ceil(pad / [...FILLER].length) + 1);
  return `${[...filler].slice(0, pad).join("")}${citation}`;
}

export type ScriptedReply = { text: string } | { fail: "unavailable" | "failed" | "cancelled" | "invalid_response"; reason: string };

export type ScriptedModel = {
  port: ModelPort;
  requests: ModelRequest[];
  judge_calls: number;
  summary_calls: number;
  nav_calls: number;
};

function response(text: string) {
  return {
    text,
    model: "scripted",
    finish_reason: "stop",
    usage: { tokens_in: 120, tokens_out: 30, cost_usd: 0.002 },
  };
}

/**
 * `route` sees the system prompt and the call count for that kind, so a test can
 * give the judge a descending script while the summary and nav have their own.
 */
export function makeScriptedModel(
  route: (kind: "judge" | "summary" | "nav", index: number, request: ModelRequest) => ScriptedReply,
  options: { fail_summary?: boolean; fail_nav?: boolean } = {},
): ScriptedModel {
  const state: ScriptedModel = {
    requests: [],
    judge_calls: 0,
    summary_calls: 0,
    nav_calls: 0,
    port: {
      async complete(request: ModelRequest): Promise<ModelResult> {
        state.requests.push(request);
        const system = request.messages[0]?.content ?? "";
        const kind = system.includes("中期摘要") ? "summary" : system.includes("导航短摘要") ? "nav" : "judge";
        const index =
          kind === "summary" ? state.summary_calls : kind === "nav" ? state.nav_calls : state.judge_calls;
        if (kind === "summary") state.summary_calls += 1;
        else if (kind === "nav") state.nav_calls += 1;
        else state.judge_calls += 1;
        if (kind === "summary" && options.fail_summary === true) {
          return { ok: false, status: "unavailable", reason: "summary_down" };
        }
        if (kind === "nav" && options.fail_nav === true) {
          return { ok: false, status: "unavailable", reason: "nav_down" };
        }
        const reply = route(kind, index, request);
        if ("fail" in reply) return { ok: false, status: reply.fail, reason: reply.reason };
        return { ok: true, value: response(reply.text) };
      },
    },
  };
  return state;
}

export function judgeScript(
  historyId: string,
  options: { layers_before_history?: number } = {},
): (kind: "judge" | "summary" | "nav", index: number) => ScriptedReply {
  const before = options.layers_before_history ?? 2;
  return (kind, index) => {
    if (kind === "summary") {
      return { text: JSON.stringify({ body: bodyOfLength(600, "e1") }) };
    }
    if (kind === "nav") {
      return { text: JSON.stringify({ nav: "这条记忆记录默认端口与回滚方式，改端口前值得读。" }) };
    }
    if (index < before) {
      return {
        text: JSON.stringify({
          sufficient: false,
          answer: null,
          evidence_ids: [],
          read_uris: [],
          next_queries: [],
          conflicts: [],
          descend: true,
        }),
      };
    }
    return {
      text: JSON.stringify({
        sufficient: true,
        answer: "历史记录里决定保持端口 8787。",
        evidence_ids: [historyId],
        read_uris: [],
        next_queries: [],
        conflicts: [],
        descend: false,
      }),
    };
  };
}
