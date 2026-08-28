import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { EpochMs } from "../time.js";

const Base = z.object({
  traceId: z.string(),
  serverName: z.string(),
  time: EpochMs,
});

export namespace Mcp {
  export namespace Events {
    export const Connected = BusEvent.define(
      "mcp.connected",
      Base.extend({
        transport: z.enum(["stdio", "sse", "streamable-http"]),
        toolCount: z.number(),
      }),
      { visibility: "internal" },
    );

    export const Disconnected = BusEvent.define("mcp.disconnected", Base, {
      visibility: "internal",
    });

    export const ToolCalled = BusEvent.define(
      "mcp.tool.called",
      Base.extend({
        toolName: z.string(),
        toolCallId: z.string(),
      }),
      { visibility: "ephemeral" },
    );

    export const ToolCompleted = BusEvent.define(
      "mcp.tool.completed",
      Base.extend({
        toolName: z.string(),
        toolCallId: z.string(),
        durationMs: z.number(),
        resultSummary: z.string(),
      }),
      { visibility: "llm_reason" },
    );

    export const ToolFailed = BusEvent.define(
      "mcp.tool.failed",
      Base.extend({
        toolName: z.string(),
        toolCallId: z.string(),
        error: z.string(),
      }),
      { visibility: "llm_reason" },
    );
  }
}
