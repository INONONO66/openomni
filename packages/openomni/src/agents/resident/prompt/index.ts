import { CLAUDE_RESIDENT_PROMPT_VARIANT } from "./claude";
import { GPT_RESIDENT_PROMPT_VARIANT } from "./gpt";
import { buildResidentPrompt, inferResidentPromptFamily } from "./shared";
import type { ResidentPromptFamily, ResidentPromptOptions, ResidentPromptVariant } from "./types";

export type {
  ResidentPromptFamily,
  ResidentPromptOptions,
  ResidentPromptSections,
  ResidentPromptVariant,
} from "./types";

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
