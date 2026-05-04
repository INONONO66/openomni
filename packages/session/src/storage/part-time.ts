import type { Message } from "@openomni/protocol";

export function getPartStartTime(part: Message.Part): number | undefined {
  if ((part.type === "text" || part.type === "reasoning") && part.time?.start !== undefined) {
    return part.time.start;
  }

  if (
    part.type === "tool" &&
    part.state.status !== "pending" &&
    part.state.time?.start !== undefined
  ) {
    return part.state.time.start;
  }

  return undefined;
}
