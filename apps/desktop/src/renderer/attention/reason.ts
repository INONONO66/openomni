import { relativeTime } from "@openomni/ui";
import type { Session } from "../state/store";

export function formatRelative(now: number, at: number): string {
  return relativeTime(at, now);
}

export function rowDensity(session: Pick<Session, "titleSource" | "phase">): "single" | "double" {
  return session.titleSource === "placeholder" && session.phase === "idle" ? "single" : "double";
}

export function sessionReason(session: Session, now: number): string {
  switch (session.phase) {
    case "waiting_approval":
      return `waiting for approval · ${formatRelative(now, session.phaseSince)}`;
    case "waiting_input":
      return `waiting for input · ${formatRelative(now, session.phaseSince)}`;
    case "interrupted":
      return `interrupted ${formatRelative(now, session.phaseSince)}`;
    case "completed":
    case "failed":
      return `${session.phase}${session.unread ? " · unread" : ""}`;
    default:
      return session.phase;
  }
}
