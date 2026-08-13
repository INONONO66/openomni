import { z } from "zod";
import { BusEvent } from "@openomni/telemetry";
import { SessionInfo } from "./info";

export const Event = {
  Created: BusEvent.define("session.created", z.object({ info: SessionInfo }), {
    visibility: "internal",
  }),
  Updated: BusEvent.define("session.updated", z.object({ info: SessionInfo }), {
    visibility: "ephemeral",
  }),
  Deleted: BusEvent.define("session.deleted", z.object({ id: z.string() }), {
    visibility: "internal",
  }),
};
