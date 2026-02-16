import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import {
  AgentDefinitionSchema,
  BuiltinAgentRegistry,
  type AgentDefinition,
} from "../registry/registry";
import { parseFrontmatter } from "./frontmatter";

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
