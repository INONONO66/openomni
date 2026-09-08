import { relativeTime } from "@openomni/ui";
import type { Session } from "../state/store";

export function sessionReason(session: Session, now: number): string {
  switch (session.phase) {
    case "waiting_approval": return `waiting for approval · ${relativeTime(session.phaseSince, now)}`;
    case "waiting_input": return `waiting for input · ${relativeTime(session.phaseSince, now)}`;
    case "interrupted": return `interrupted ${relativeTime(session.phaseSince, now)} ago`;
    case "completed": case "failed": return `${session.phase}${session.unread ? " · unread" : ""}`;
    default: return session.phase;
  }
}
