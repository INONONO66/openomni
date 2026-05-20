interface SkillMarkdownParts {
  readonly header: string;
  readonly body: string;
}

export interface SkillMetadata {
  id?: string;
  name?: string;
  description?: string;
  layer?: string;
  useWhen?: string;
  doNotUseWhen?: string;
  finalChecklist?: string[];
  mcpTools?: string[];
  promptFragment?: string;
}

export function parseSkillMarkdown(text: string): SkillMetadata {
  const parts = extractMarkdownParts(text);
  const header = parts.header;
  let metadata: SkillMetadata = {};
  let currentKey: keyof SkillMetadata | undefined;

  for (const rawLine of header.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim().length === 0) continue;

    const listItem = /^\s*-\s+(.+)$/.exec(line);
    if (listItem && isListMetadataKey(currentKey)) {
      metadata = appendSkillMetadataItem(metadata, currentKey, stripQuotes(listItem[1] ?? ""));
      continue;
    }

    const continuation = /^\s+(.+)$/.exec(line);
    if (continuation && currentKey && !isListMetadataKey(currentKey)) {
      const previous = metadata[currentKey];
      const next = stripQuotes(continuation[1] ?? "");
      if (typeof previous === "string") {
        metadata = assignSkillMetadata(
          metadata,
          currentKey,
          previous.length === 0 ? next : `${previous}\n${next}`,
        );
      }
      continue;
    }

    const pair = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (!pair) continue;

    const key = normalizeSkillKey(pair[1] ?? "");
    if (!key) {
      currentKey = undefined;
      continue;
    }

    const value = pair[2] ?? "";
    currentKey = key;
    if (isListMetadataKey(key)) {
      metadata = assignSkillMetadataList(metadata, key, value);
      continue;
    }

    metadata = assignSkillMetadata(metadata, key, value.trim() === "|" ? "" : stripQuotes(value));
  }

  if (!metadata.promptFragment?.trim()) {
    const promptFragment = parts.body.trim() || metadata.description;
    if (promptFragment) metadata = { ...metadata, promptFragment };
  }

  return metadata;
}

function assignSkillMetadata(
  metadata: SkillMetadata,
  key: keyof SkillMetadata,
  value: string,
): SkillMetadata {
  switch (key) {
    case "id":
      return { ...metadata, id: value };
    case "name":
      return { ...metadata, name: value };
    case "description":
      return { ...metadata, description: value };
    case "layer":
      return { ...metadata, layer: value };
    case "useWhen":
      return { ...metadata, useWhen: value };
    case "doNotUseWhen":
      return { ...metadata, doNotUseWhen: value };
    case "finalChecklist":
      return { ...metadata, finalChecklist: [value] };
    case "mcpTools":
      return { ...metadata, mcpTools: [value] };
    case "promptFragment":
      return { ...metadata, promptFragment: value };
  }
}

function isListMetadataKey(
  key: keyof SkillMetadata | undefined,
): key is "finalChecklist" | "mcpTools" {
  return key === "finalChecklist" || key === "mcpTools";
}

function assignSkillMetadataList(
  metadata: SkillMetadata,
  key: "finalChecklist" | "mcpTools",
  value: string,
): SkillMetadata {
  const item = stripQuotes(value);
  return item.length === 0
    ? { ...metadata, [key]: [] }
    : appendSkillMetadataItem(metadata, key, item);
}

function appendSkillMetadataItem(
  metadata: SkillMetadata,
  key: "finalChecklist" | "mcpTools",
  value: string,
): SkillMetadata {
  if (key === "finalChecklist") {
    return { ...metadata, finalChecklist: [...(metadata.finalChecklist ?? []), value] };
  }
  return { ...metadata, mcpTools: [...(metadata.mcpTools ?? []), value] };
}

function extractMarkdownParts(text: string): SkillMarkdownParts {
  if (text.startsWith("---\n") || text.startsWith("---\r\n")) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (match) return { header: match[1] ?? "", body: text.slice(match[0].length) };
  }

  const lines: string[] = [];
  const allLines = text.split("\n");
  let bodyStart = allLines.length;
  for (const [index, line] of allLines.entries()) {
    if (line.trim().length === 0) {
      bodyStart = index + 1;
      break;
    }
    lines.push(line);
  }

  return { header: lines.join("\n"), body: allLines.slice(bodyStart).join("\n") };
}

function normalizeSkillKey(key: string): keyof SkillMetadata | undefined {
  switch (key) {
    case "id":
    case "name":
    case "description":
    case "layer":
    case "useWhen":
    case "doNotUseWhen":
    case "finalChecklist":
    case "mcpTools":
    case "promptFragment":
      return key;
    default:
      return undefined;
  }
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}
