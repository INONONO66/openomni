/**
 * The delegate boundary is advertised as one flat object: providers on the
 * Anthropic wire reject a root-level oneOf input_schema. Runtime admission
 * still enforces the scope/actorId XOR and operation-specific fields.
 */
export const DELEGATE_WIRE_PROJECTION: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["instruction", "operation", "timeoutMs"],
  properties: {
    instruction: {
      type: "string",
      minLength: 1,
      description: "What the worker must do, self-contained.",
    },
    operation: {
      type: "string",
      enum: ["notify", "ask", "assign"],
      description:
        "notify = fire-and-forget, ask = expect an answer, assign = accountable work (creates a WorkItem).",
    },
    acceptanceCriteria: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "assign only: criteria the work must satisfy to complete.",
    },
    verification: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "executable", "argv", "timeoutMs", "expectations"],
      description:
        "assign only: the command that checks the criteria it binds. Without it the work settles unverified — a worker's own report is never proof.",
      properties: {
        kind: { type: "string", enum: ["command.v1"] },
        executable: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9._-]{0,63}$",
              description: "Owner-registered executable id; never a path or a shell string.",
            },
          },
        },
        argv: {
          type: "array",
          maxItems: 64,
          items: { type: "string", maxLength: 4096 },
          description: "Literal arguments; no shell parsing happens.",
        },
        timeoutMs: { type: "integer", exclusiveMinimum: 0, maximum: 600000 },
        expectations: {
          type: "array",
          minItems: 1,
          description: "Each entry binds one acceptanceCriteria index to an expected observation.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["criterionIndex", "exitCode"],
            properties: {
              criterionIndex: { type: "integer", minimum: 0 },
              exitCode: { type: "integer" },
              stdoutSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
              stderrSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
            },
          },
        },
      },
    },
    timeoutMs: {
      type: "integer",
      exclusiveMinimum: 0,
      description: "Deadline in milliseconds; settlement arrives by then or as no_response.",
    },
    scope: {
      type: "string",
      enum: ["inline", "independent"],
      description:
        "Worker placement: inline = same-process worker, independent = spawned child process. Provide exactly one of scope or actorId.",
    },
    actorId: {
      type: "string",
      minLength: 1,
      description:
        "Channel contact to ask instead of a worker. Provide exactly one of scope or actorId.",
    },
  },
};
