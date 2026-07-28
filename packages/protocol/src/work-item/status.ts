import type { Info, Status } from "./schemas.js";

export function deriveStatus(item: Info): Status {
  if (item.timestamps.cancelled !== undefined) return "cancelled";
  if (item.timestamps.failed !== undefined) return "failed";
  if (item.timestamps.completed !== undefined) return "completed";
  if (item.blockers.some((blocker) => blocker.resolvedAt === undefined)) return "blocked";
  if (item.timestamps.started !== undefined) return "running";
  return "pending";
}
