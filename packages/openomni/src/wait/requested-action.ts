import { Wait } from "@openomni/protocol";

/**
 * Parses the wait action an inbound payload requests (#548). Absence and
 * unknown shapes default to report_result; admissibility is decided by the
 * matched wait's allowedActions gate (resolve-route / dispatch authority),
 * never here. One parser serves ingress and dispatch so the two phases can
 * never disagree about what a payload asked for.
 */
export function requestedWaitAction(payload: unknown): Wait.AllowedAction {
  if (payload !== null && typeof payload === "object" && "action" in payload) {
    const action = Wait.AllowedAction.safeParse(payload.action);
    if (action.success) return action.data;
  }
  return "report_result";
}
