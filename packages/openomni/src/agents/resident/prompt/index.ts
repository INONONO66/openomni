import type { Model } from "@openomni/protocol";
import { CLAUDE_RESIDENT_PROMPT_VARIANT } from "./claude";
import { GPT_RESIDENT_PROMPT_VARIANT } from "./gpt";

// merged from types.ts (fragment sweep)
export type ResidentPromptFamily = "claude" | "gpt";

export interface ResidentPromptSections {
  readonly identity: string;
  readonly operatingPhilosophy: string;
  readonly philosophicalAlignment: string;
  readonly workflow: string;
  readonly delegation: string;
  readonly toolUse: string;
  readonly verification: string;
  readonly boundaries: string;
}

export interface ResidentPromptVariant {
  readonly family: ResidentPromptFamily;
  readonly sections: ResidentPromptSections;
}

export interface ResidentPromptOptions {
  readonly model?: Model.Ref;
  readonly family?: ResidentPromptFamily;
}

// merged from shared.ts (fragment sweep)
function buildResidentPrompt(sections: ResidentPromptSections): string {
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

function inferResidentPromptFamily(model: Model.Ref): ResidentPromptFamily {
  const provider = model.provider.toLowerCase();
  const id = model.id.toLowerCase();

  if (provider.includes("anthropic") || id.includes("claude")) return "claude";
  if (provider.includes("openai") || id.includes("gpt") || /^o\d/.test(id)) return "gpt";

  return "claude";
}

export namespace ResidentAgent {
  const promptVariants: Record<ResidentPromptFamily, ResidentPromptVariant> = {
    claude: CLAUDE_RESIDENT_PROMPT_VARIANT,
    gpt: GPT_RESIDENT_PROMPT_VARIANT,
  };

  function getPromptVariant(options: ResidentPromptOptions = {}): ResidentPromptVariant {
    if (options.family) return promptVariants[options.family];
    if (options.model) return promptVariants[inferResidentPromptFamily(options.model)];
    return promptVariants.claude;
  }

  export function getPrompt(options: ResidentPromptOptions = {}): string {
    return buildResidentPrompt(getPromptVariant(options).sections);
  }
}
