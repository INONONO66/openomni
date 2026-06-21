import type { ToolSelection } from "@openomni/protocol";
import type { NativeTool, ToolSource } from "./types.js";

const DEFAULT_CATEGORY_MAP: Record<string, ToolSelection.Category> = {
  read: "filesystem",
  write: "filesystem",
  edit: "filesystem",
  glob: "filesystem",
  "grep.search": "filesystem",
  bash: "execution",
  dispatch: "delegation",
  child_agent: "delegation",
};

export interface CatalogEntry {
  tool: NativeTool;
  canonicalName: string;
  category: ToolSelection.Category;
  source: ToolSource;
}

export function resolveCategory(
  canonicalName: string,
  source: ToolSource,
  explicitCategory?: ToolSelection.Category,
): ToolSelection.Category {
  if (explicitCategory) return explicitCategory;
  const mapped = DEFAULT_CATEGORY_MAP[canonicalName];
  if (mapped) return mapped;
  if (source === "mcp") return "mcp";
  return "custom";
}

export function buildToolCatalog(
  providers: Array<{ tools: NativeTool[]; source: ToolSource }>,
): CatalogEntry[] {
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  for (const { tools, source } of providers) {
    for (const tool of tools) {
      const canonicalName = tool.spec.name;
      if (seen.has(canonicalName)) {
        throw new Error(`Duplicate canonical tool name: "${canonicalName}"`);
      }
      seen.add(canonicalName);
      entries.push({
        tool,
        canonicalName,
        category: resolveCategory(canonicalName, source, tool.category),
        source,
      });
    }
  }
  return entries;
}

export function resolveToolSelection(
  catalog: CatalogEntry[],
  selection: ToolSelection.Selection,
  parentAllowed?: Set<string>,
  depth = 0,
): CatalogEntry[] {
  // Step 1: base set
  let result: CatalogEntry[];
  if (selection.all) {
    result = [...catalog];
  } else if (selection.categories && selection.categories.length > 0) {
    const cats = new Set(selection.categories);
    result = catalog.filter((e) => cats.has(e.category));
  } else {
    result = [];
  }

  // Step 2: + allow
  if (selection.allow && selection.allow.length > 0) {
    const allowSet = new Set(selection.allow);
    const existing = new Set(result.map((e) => e.canonicalName));
    for (const entry of catalog) {
      if (allowSet.has(entry.canonicalName) && !existing.has(entry.canonicalName)) {
        result.push(entry);
      }
    }
  }

  // Step 3: ∩ parent
  if (parentAllowed) {
    result = result.filter((e) => parentAllowed.has(e.canonicalName));
  }

  // Step 4: depth deny
  if (depth >= 1) {
    result = result.filter((e) => e.category !== "delegation");
  }
  if (depth >= 2) {
    result = result.filter((e) => e.category !== "execution");
  }

  // Step 5: - deny
  if (selection.deny && selection.deny.length > 0) {
    const denySet = new Set(selection.deny);
    result = result.filter((e) => !denySet.has(e.canonicalName));
  }

  return result;
}
