import { Wait } from "@openomni/protocol";

/**
 * The wait action an inbound payload requests (#548), as a three-way parse:
 * an ABSENT action (plain text, non-object, or no `action` key) defaults to
 * "report_result"; a valid Wait.AllowedAction member parses to itself; a
 * PRESENT-but-invalid action parses to the typed "invalid" sentinel. The
 * sentinel is a member of no allowedActions list, so every admissibility
 * gate (resolve-route wait correlation, dispatch pinned revalidation, the
 * dispatch PI router) treats it as disallowed — an explicitly wrong action
 * blocks fail-closed instead of coercing to the default and routing with
 * matched worker context. One parser serves ingress and dispatch so the two
 * phases can never disagree about what a payload asked for.
 */
export type RequestedWaitAction = Wait.AllowedAction | "invalid";

export function requestedWaitAction(payload: unknown): RequestedWaitAction {
  if (payload === null || typeof payload !== "object" || !("action" in payload)) {
    return "report_result";
  }
  const action = Wait.AllowedAction.safeParse(payload.action);
  return action.success ? action.data : "invalid";
}
