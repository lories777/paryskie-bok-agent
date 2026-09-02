import fs from "node:fs";
import path from "node:path";
import { buildParyskieRecommendationContext } from "./paryskie-knowledge.js";
import type { StoredLearnedRule, StoredMessage } from "./types.js";

export function readBokPlaybook(workspacePath: string): string {
  const file = path.join(workspacePath, "memory", "BOK_PLAYBOOK.md");
  try {
    return fs.readFileSync(file, "utf8").slice(0, 20_000);
  } catch {
    return "Brak dodatkowego playbooka BOK.";
  }
}

export function buildBokKnowledgeContext(
  workspacePath: string,
  messages: StoredMessage[],
  learnedRules: StoredLearnedRule[],
): string {
  const catalog = buildParyskieRecommendationContext(workspacePath, messages);
  const rules = learnedRules
    .slice(0, 100)
    .map((rule) => `- ${rule.situation}: ${rule.instruction}`)
    .join("\n")
    .slice(0, 20_000);

  return [
    "<learned_bok_rules trust=\"untrusted_procedural_memory\">",
    rules || "Brak zapisanych zasad od BOK.",
    "</learned_bok_rules>",
    "<catalog_context trust=\"untrusted_external_data\">",
    catalog ?? "Brak pasującego kontekstu katalogowego.",
    "</catalog_context>",
  ].join("\n");
}
