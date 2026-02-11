import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import {
  AgentDefinitionSchema,
  BuiltinAgentRegistry,
  type AgentDefinition,
} from "./registry";

export interface AgentLoadResult {
  file: string;
  success: boolean;
  agent?: AgentDefinition;
  error?: string;
}

export interface AgentDiscoveryOptions {
  allowOverride?: boolean;
  strict?: boolean;
}

/**
 * Extracts YAML frontmatter (between `---` delimiters) and markdown body.
 * Supports: scalars, booleans, numbers, inline arrays `[a, b]`,
 * block arrays (`- item`), and one-level nested objects.
 */
export function parseFrontmatter(content: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") {
    throw new Error("Missing frontmatter: file must start with ---");
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    throw new Error("Missing frontmatter: no closing --- found");
  }

  const yamlLines = lines.slice(1, closingIndex);
  const body = lines
    .slice(closingIndex + 1)
    .join("\n")
    .trim();
  const data = parseSimpleYaml(yamlLines);

  return { data, body };
}

/**
 * Minimal YAML parser for frontmatter. Handles flat key-value pairs,
 * inline arrays `[a, b]`, block arrays (`- item`), and single-level
 * nested objects (e.g., `permissions:` / `model:`).
 */
function parseSimpleYaml(lines: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const topMatch = line.match(/^(\w[\w.-]*)\s*:\s*(.*)/);
    if (!topMatch) {
      i++;
      continue;
    }

    const key = topMatch[1]!;
    const rawValue = topMatch[2]!.trim();

    if (rawValue === "") {
      const nested: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j]!;
        if (nextLine.trim() === "" || nextLine.trim().startsWith("#")) {
          j++;
          continue;
        }
        if (nextLine.startsWith("  ")) {
          nested.push(nextLine);
          j++;
        } else {
          break;
        }
      }

      if (nested.length > 0) {
        const isBlockArray = nested.every(
          (l) => l.trim().startsWith("- ") || l.trim() === "",
        );

        if (isBlockArray) {
          result[key] = nested
            .filter((l) => l.trim().startsWith("- "))
            .map((l) => parseScalar(l.trim().slice(2).trim()));
        } else {
          const obj: Record<string, unknown> = {};
          for (const nl of nested) {
            const nestedMatch = nl.match(/^\s+(\w[\w.-]*)\s*:\s*(.*)/);
            if (nestedMatch) {
              obj[nestedMatch[1]!] = parseScalar(nestedMatch[2]!.trim());
            }
          }
          result[key] = obj;
        }
        i = j;
        continue;
      }
    }

    result[key] = parseValue(rawValue);
    i++;
  }

  return result;
}

function parseValue(raw: string): unknown {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => parseScalar(s.trim()));
  }

  return parseScalar(raw);
}

function parseScalar(raw: string): unknown {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }

  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;

  const num = Number(raw);
  if (raw !== "" && !isNaN(num)) return num;

  return raw;
}

/**
 * File-based agent discovery. Loads agent definitions from `*.md` files
 * where YAML frontmatter provides the definition and the markdown body
 * extends the systemPrompt. Validates all definitions with Zod.
 */
export namespace AgentDiscovery {
  export function load(
    dir: string,
    options: AgentDiscoveryOptions = {},
  ): AgentLoadResult[] {
    const { allowOverride = false, strict = false } = options;
    const results: AgentLoadResult[] = [];

    if (!existsSync(dir)) {
      if (strict) {
        throw new Error(`Agent discovery directory does not exist: ${dir}`);
      }
      return results;
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err: unknown) {
      if (strict) throw err;
      return results;
    }

    const mdFiles = entries.filter((f) => extname(f) === ".md").sort();

    for (const file of mdFiles) {
      const result = loadFile(join(dir, file), { allowOverride, strict });
      results.push(result);
    }

    return results;
  }

  export function loadFile(
    filePath: string,
    options: AgentDiscoveryOptions = {},
  ): AgentLoadResult {
    const { allowOverride = false, strict = false } = options;
    const file = filePath;

    try {
      const content = readFileSync(filePath, "utf-8");
      const { data, body } = parseFrontmatter(content);

      if (body && typeof data.systemPrompt === "string") {
        data.systemPrompt = data.systemPrompt + "\n\n" + body;
      } else if (body && !data.systemPrompt) {
        data.systemPrompt = body;
      }

      const validated = AgentDefinitionSchema.parse(data);

      if (BuiltinAgentRegistry.has(validated.name)) {
        if (!allowOverride) {
          const msg = `Agent "${validated.name}" already exists and allowOverride is not set`;
          if (strict) throw new Error(msg);
          return { file, success: false, error: msg };
        }
        return overrideAgent(validated, file);
      }

      BuiltinAgentRegistry.define(validated);

      return { file, success: true, agent: validated };
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Unknown error loading agent file";
      if (strict) throw err;
      return { file, success: false, error: msg };
    }
  }

  /**
   * Atomically replaces an existing agent by clearing and re-registering all agents.
   * Required because BuiltinAgentRegistry.define() throws on duplicate names.
   */
  function overrideAgent(
    definition: AgentDefinition,
    file: string,
  ): AgentLoadResult {
    const existing = BuiltinAgentRegistry.list();
    BuiltinAgentRegistry.clear();

    for (const agent of existing) {
      if (agent.name === definition.name) {
        BuiltinAgentRegistry.define(definition);
      } else {
        BuiltinAgentRegistry.define(agent);
      }
    }

    if (!BuiltinAgentRegistry.has(definition.name)) {
      BuiltinAgentRegistry.define(definition);
    }

    return { file, success: true, agent: definition };
  }
}
