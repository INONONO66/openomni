import { z } from "zod";
import { BusEvent } from "@openomni/telemetry";
import { SessionInfo } from "./info";

export const Event = {
  Created: BusEvent.define(
    "session.created",
    z.object({ traceId: z.string().min(1), info: SessionInfo }),
    { visibility: "internal" },
  ),
  // Updated is ephemeral: dropped before persistence, so it carries no trace.
  Updated: BusEvent.define("session.updated", z.object({ info: SessionInfo }), {
    visibility: "ephemeral",
  }),
  Deleted: BusEvent.define(
    "session.deleted",
    z.object({ traceId: z.string().min(1), id: z.string() }),
    { visibility: "internal" },
  ),
};
