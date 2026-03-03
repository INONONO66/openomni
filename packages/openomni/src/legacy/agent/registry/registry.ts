import { z } from "zod";

/**
 * Agent Definition - Zod-first schema for agent configuration
 * Defines an agent's capabilities, tools, permissions, and constraints
 */
export const AgentDefinitionSchema = z.object({
  name: z.string().describe("Unique identifier for the agent"),
  description: z.string().describe("Human-readable description of the agent"),
  systemPrompt: z.string().describe("System prompt to guide agent behavior"),
  tools: z.array(z.string()).describe("List of tools the agent can use"),
  model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional()
    .describe("Model configuration for the agent"),
  permissions: z
    .object({
      read: z.boolean().default(false),
      write: z.boolean().default(false),
      bash: z.boolean().default(false),
      lsp: z.boolean().default(false),
      grep: z.boolean().default(false),
      glob: z.boolean().default(false),
    })
    .describe("Permission set for the agent"),
  maxTurns: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of turns for the agent"),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/**
 * Built-in Agent Registry - Namespace for managing agent definitions
 * Provides registration, lookup, and listing of built-in agents
 */
export namespace BuiltinAgentRegistry {
  const registry = new Map<string, AgentDefinition>();
  let initialized = false;

  /**
   * Define and register a new agent
   * @param definition The agent definition to register
   * @throws ZodError if definition is invalid
   * @throws Error if agent with same name already exists
   */
  export function define(definition: AgentDefinition): AgentDefinition {
    if (!initialized) {
      initializeBuiltins();
    }

    const validated = AgentDefinitionSchema.parse(definition);

    if (registry.has(validated.name)) {
      throw new Error(
        `Agent "${validated.name}" is already registered in the registry`,
      );
    }

    registry.set(validated.name, validated);
    return validated;
  }

  /**
   * Get an agent definition by name
   * @param name The agent name
   * @returns The agent definition or undefined if not found
   */
  export function get(name: string): AgentDefinition | undefined {
    if (!initialized) {
      initializeBuiltins();
    }
    return registry.get(name);
  }

  /**
   * List all registered agents
   * @returns Array of all registered agent definitions
   */
  export function list(): AgentDefinition[] {
    if (!initialized) {
      initializeBuiltins();
    }
    return Array.from(registry.values());
  }

  /**
   * Check if an agent is registered
   * @param name The agent name
   * @returns true if agent exists
   */
  export function has(name: string): boolean {
    if (!initialized) {
      initializeBuiltins();
    }
    return registry.has(name);
  }

  /**
   * Clear all registered agents and prevent re-initialization
   */
  export function clear(): void {
    registry.clear();
    initialized = true;
  }

  /**
   * Get the count of registered agents
   */
  export function size(): number {
    if (!initialized) {
      initializeBuiltins();
    }
    return registry.size;
  }

  /**
   * Initialize built-in agents
   * Can be called explicitly for testing or called lazily on first access
   * Calling this after clear() will re-populate the registry
   */
  export function initializeBuiltins(): void {
    initialized = true;
    initializeBuiltinsInternal();
  }

  function initializeBuiltinsInternal(): void {
    // explore: read-only agent for research and analysis
    define({
      name: "explore",
      description:
        "Read-only agent for exploring codebases, documentation, and information gathering",
      systemPrompt:
        "You are an expert code explorer and researcher. Your role is to analyze, understand, and explain code and documentation. You have read-only access to files and can search for patterns. Focus on understanding structure, dependencies, and design patterns.",
      tools: ["read", "grep", "glob", "bash"],
      permissions: {
        read: true,
        write: false,
        bash: true,
        lsp: false,
        grep: true,
        glob: true,
      },
      maxTurns: 20,
    });

    // implement: full-access agent for implementation
    define({
      name: "implement",
      description:
        "Full-access agent for implementing features, refactoring, and code generation",
      systemPrompt:
        "You are an expert software engineer. Your role is to implement features, refactor code, and generate solutions. You have full access to all tools and can read, write, and execute code. Focus on clean, maintainable, and well-tested implementations.",
      tools: [
        "read",
        "write",
        "edit",
        "bash",
        "grep",
        "glob",
        "lsp_goto_definition",
        "lsp_find_references",
        "lsp_symbols",
        "lsp_diagnostics",
        "lsp_prepare_rename",
        "lsp_rename",
        "ast_grep_search",
        "ast_grep_replace",
      ],
      permissions: {
        read: true,
        write: true,
        bash: true,
        lsp: true,
        grep: true,
        glob: true,
      },
      maxTurns: 30,
    });

    // review: read + LSP agent for code review and analysis
    define({
      name: "review",
      description:
        "Code review agent with read access and LSP tools for deep analysis",
      systemPrompt:
        "You are an expert code reviewer. Your role is to analyze code quality, identify issues, and suggest improvements. You have read access and LSP tools for deep code understanding. Focus on correctness, performance, maintainability, and best practices.",
      tools: [
        "read",
        "grep",
        "glob",
        "lsp_goto_definition",
        "lsp_find_references",
        "lsp_symbols",
        "lsp_diagnostics",
      ],
      permissions: {
        read: true,
        write: false,
        bash: false,
        lsp: true,
        grep: true,
        glob: true,
      },
      maxTurns: 15,
    });

    // test: read + write + bash agent for testing
    define({
      name: "test",
      description:
        "Testing agent with read, write, and bash access for test development and execution",
      systemPrompt:
        "You are an expert test engineer. Your role is to write, execute, and maintain tests. You have read, write, and bash access. Focus on comprehensive test coverage, edge cases, and test quality.",
      tools: ["read", "write", "bash", "grep", "glob"],
      permissions: {
        read: true,
        write: true,
        bash: true,
        lsp: false,
        grep: true,
        glob: true,
      },
      maxTurns: 25,
    });
  }
}
