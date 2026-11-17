import type { LayeredSearchOutcome, MemoryReadOutcome } from "@vestigio/core/retrieval";

function clip(text: string, max: number): string {
  const points = [...text];
  if (points.length <= max) {
    return text;
  }
  return `${points.slice(0, max).join("")}…`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export type SearchContext = {
  /** The resolved `obelisk.sqlite` path, or null when history was not asked for. */
  history_index: string | null;
};

export function formatSearchHuman(outcome: LayeredSearchOutcome, context: SearchContext): string {
  const lines: string[] = [];
  lines.push(`status: ${outcome.result.status}`);
  lines.push(`cards: ${outcome.result.cards.length}`);
  for (const card of outcome.result.cards) {
    lines.push(
      `  [${card.state}] ${card.uri} rev ${card.revision} score ${round(card.score)} ${card.title}`,
    );
    lines.push(`    nav: ${clip(card.nav_text, 80)}`);
  }

  lines.push("layers:");
  for (const layer of outcome.layers) {
    const bits = [`candidates ${layer.candidates}`, `emitted ${layer.emitted}`];
    if (layer.reason !== null) {
      bits.push(`reason ${layer.reason}`);
    }
    if (layer.evidence !== null) {
      bits.push(`evidence ${layer.evidence}`);
    }
    if (layer.read) {
      bits.push("read yes");
    }
    lines.push(`  ${layer.layer}: ${layer.status} (${bits.join(", ")})`);
  }

  if (outcome.history.length > 0) {
    lines.push(`history excerpts: ${outcome.history.length}`);
    for (const entry of outcome.history) {
      const ref = entry.source_ref;
      lines.push(
        `  [${entry.via}] ${ref.provider}/${ref.source_instance} ${ref.locator ?? ref.message_id}` +
          `${entry.truncated ? " (truncated)" : ""}`,
      );
      lines.push(`    ${clip(entry.excerpt.replace(/\s+/gu, " "), 120)}`);
    }
  }

  if (outcome.result.conflicts.length > 0) {
    lines.push(`conflicts: ${outcome.result.conflicts.join(", ")}`);
  }
  if (outcome.result.missing.length > 0) {
    lines.push(`missing: ${outcome.result.missing.join(", ")}`);
  }
  lines.push(`next_action: ${outcome.result.next_action ?? "null"}`);
  lines.push(
    `bytes: ${outcome.measured.result_bytes}  est_tokens: ${outcome.measured.estimated_tokens}  ` +
      `elapsed_ms: ${round(outcome.result.budget_used.elapsed_ms)}  model_calls: ${outcome.result.budget_used.model_calls}`,
  );
  if (context.history_index !== null) {
    lines.push(`history_index: ${context.history_index}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatReadHuman(outcome: MemoryReadOutcome): string {
  const lines: string[] = [];
  lines.push(`status: ${outcome.result.status}`);
  if (outcome.result.memory_uri === null) {
    lines.push(`missing: ${outcome.result.missing.join(", ")}`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(`memory: ${outcome.result.memory_uri} revision ${outcome.result.revision ?? "(none)"}`);
  lines.push(`navigation: ${outcome.result.navigation_status}`);
  if (outcome.result.cards.length > 0) {
    lines.push(`title: ${outcome.result.cards[0]?.title ?? ""}`);
    lines.push(`nav: ${outcome.result.cards[0]?.nav_text ?? ""}`);
  }
  lines.push(`sources: ${outcome.result.evidence.length}`);
  lines.push(`summary_chars: ${[...(outcome.result.memory_summary ?? "")].length}`);
  lines.push("--- summary ---");
  lines.push(outcome.result.memory_summary ?? "");
  lines.push(
    `bytes: ${outcome.measured.result_bytes}  est_tokens: ${outcome.measured.estimated_tokens}  ` +
      `elapsed_ms: ${round(outcome.result.budget_used.elapsed_ms)}  model_calls: ${outcome.result.budget_used.model_calls}`,
  );
  return `${lines.join("\n")}\n`;
}
