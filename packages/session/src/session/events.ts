import { z } from "zod";
import { BusEvent } from "../bus";
import { SessionInfo } from "./info";

export const Event = {
  Created: BusEvent.define("session.created", z.object({ info: SessionInfo })),
  Updated: BusEvent.define("session.updated", z.object({ info: SessionInfo })),
  Deleted: BusEvent.define("session.deleted", z.object({ id: z.string() })),
};
