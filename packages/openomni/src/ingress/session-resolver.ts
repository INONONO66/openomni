import { Session, SurfaceKey } from "@openomni/session";

// Minimal event shape needed for session resolution.
// Full InboundEvent type from @openomni/protocol will be used
// in T5/T6 when wiring everything together.
interface ResolvableEvent {
  surface: string;
  workspace?: string;
  channel?: string;
}

// Default model config when creating new sessions
export interface ModelConfig {
  providerID: string;
  modelID: string;
}

export namespace IngressSessionResolver {
  export interface ResolveResult {
    session: Session.Info;
    isNew: boolean;
  }

  /**
   * Build a SurfaceKey from event origin fields.
   * Format: "surface:workspace:channel" (always 3 positional parts).
   * Missing workspace/channel are represented as empty strings to prevent collisions.
   * Examples:
   *   {surface: "slack", workspace: "team-a", channel: "C123"} → "slack:team-a:C123"
   *   {surface: "tui", workspace: "/project"} → "tui:/project:"
   *   {surface: "tui"} → "tui::"
   *   {surface: "slack", channel: "C123"} → "slack::C123"
   */
  export function extractSurfaceKey(event: ResolvableEvent): string {
    const parts = [event.surface, event.workspace ?? "", event.channel ?? ""];
    return SurfaceKey.create(parts);
  }

  /**
   * Resolve a session for the given event.
   * Looks up the SurfaceKey in the SurfaceKey registry.
   * If found and session exists → reuse it.
   * If found but session missing (stale) → create new + re-register.
   * If not found → create new + register.
   */
  export function resolve(
    event: ResolvableEvent,
    defaultModel: ModelConfig = {
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet-20241022",
    },
  ): ResolveResult {
    const surfaceKey = extractSurfaceKey(event);
    const existingSessionId = SurfaceKey.lookup(surfaceKey);

    if (existingSessionId) {
      const existing = Session.get(existingSessionId);
      if (existing) {
        return { session: existing, isNew: false };
      }
      // Stale entry — session was deleted, create new
    }

    // Create new session and register
    const session = Session.create({
      title: `Session from ${event.surface}`,
      model: defaultModel,
    });
    SurfaceKey.register(surfaceKey, session.id);
    return { session, isNew: true };
  }
}
