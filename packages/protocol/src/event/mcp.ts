import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const Base = z.object({
  traceId: z.string(),
  serverName: z.string(),
  time: z.number(),
});

export namespace Mcp {
  export const Connected = BusEvent.define(
    "mcp.connected",
    Base.extend({
      transport: z.enum(["stdio", "sse", "http"]),
      toolCount: z.number(),
    }),
  );

  export const Disconnected = BusEvent.define("mcp.disconnected", Base);

  export const ToolCalled = BusEvent.define(
    "mcp.tool.called",
    Base.extend({
      toolName: z.string(),
      toolCallId: z.string(),
    }),
  );

  export const ToolFailed = BusEvent.define(
    "mcp.tool.failed",
    Base.extend({
      toolName: z.string(),
      toolCallId: z.string(),
      error: z.string(),
    }),
  );
}
