import z from "zod";

export namespace Agent {
  /**
   * Agent schema with required name and optional fields
   * - name: unique identifier for the agent
   * - description: human-readable description of the agent's purpose
   * - systemPrompt: system prompt to guide the agent's behavior
   * - temperature: controls randomness in responses (0-2, default undefined)
   */
  export const Info = z.object({
    name: z.string().describe("Unique identifier for the agent"),
    description: z.string().optional().describe("Human-readable description of the agent"),
    systemPrompt: z.string().optional().describe("System prompt to guide agent behavior"),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe("Temperature for response randomness (0-2)"),
  });

  export type Info = z.infer<typeof Info>;

  /**
   * Default agents provided by the system
   */
  export const defaults: Record<string, Info> = {
    assistant: {
      name: "assistant",
      description: "A helpful AI assistant for general-purpose tasks",
      systemPrompt:
        "You are a helpful, harmless, and honest AI assistant. Provide clear, concise, and accurate responses.",
    },
  };
}
