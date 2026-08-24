/**
 * How a delegated instruction reads when it reaches the worker — one renderer
 * because the inline loop's opening message and the channel driver's outbound
 * body are the SAME contract text: the instruction, then what makes it done.
 */
export function renderInstruction(
  instruction: string,
  acceptanceCriteria: readonly string[],
): string {
  if (acceptanceCriteria.length === 0) return instruction;
  return [
    instruction,
    "",
    "It is done when all of these hold:",
    ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
  ].join("\n");
}
