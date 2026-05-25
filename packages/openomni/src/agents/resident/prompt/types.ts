import type { Model } from "@openomni/protocol";

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
