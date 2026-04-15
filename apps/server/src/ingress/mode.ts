export type IngressMode = "direct" | "plan";

export function detectMode(text: string): { mode: IngressMode; text: string } {
  const trimmed = text.trimStart();

  if (!trimmed.startsWith("/")) {
    return { mode: "direct", text };
  }

  const command = trimmed.match(/^\/(\S+)/)?.[1];
  if (command !== "plan") {
    return { mode: "direct", text };
  }

  return {
    mode: command,
    text: trimmed.slice(command.length + 1).trimStart(),
  };
}
