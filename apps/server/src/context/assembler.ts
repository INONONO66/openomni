import { InstructionLoader } from "./instructions";
import { SkillLoader } from "./skills";

export interface AssembleConfig {
  workspaceRoot: string;
  globalConfigDir?: string;
}

export namespace ContextAssembler {
  export function assemble(config: AssembleConfig): string {
    const { workspaceRoot, globalConfigDir } = config;

    const instructionFiles = InstructionLoader.discover(workspaceRoot, globalConfigDir);
    const instructionText = InstructionLoader.load(instructionFiles);

    const skills = SkillLoader.discover(workspaceRoot, globalConfigDir);
    const skillsText = SkillLoader.format(skills);

    if (!instructionText && !skillsText) return "";
    if (!skillsText) return instructionText;
    if (!instructionText) return skillsText;

    return `${instructionText}\n\n${skillsText}`;
  }
}
