import type { Model } from "@openomni/protocol";
import type { ResidentPromptFamily, ResidentPromptSections } from "./types";

export function buildResidentPrompt(sections: ResidentPromptSections): string {
  return [
    sections.identity,
    sections.operatingPhilosophy,
    sections.philosophicalAlignment,
    sections.workflow,
    sections.delegation,
    sections.toolUse,
    sections.verification,
    sections.boundaries,
  ]
    .map((section) => section.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function inferResidentPromptFamily(model: Model.Ref): ResidentPromptFamily {
  const provider = model.provider.toLowerCase();
  const id = model.id.toLowerCase();

  if (provider.includes("anthropic") || id.includes("claude")) return "claude";
  if (provider.includes("openai") || id.includes("gpt") || /^o\d/.test(id)) return "gpt";

  return "claude";
}
