import { Session, SurfaceKey } from "@openomni/session";

interface ResolvableEvent {
  surface: string;
  workspace?: string;
  channel?: string;
}

export interface ModelConfig {
  providerID: string;
  modelID: string;
}

export namespace IngressSessionResolver {
  export interface ResolveResult {
    session: Session.Info;
    isNew: boolean;
  }

  // Format: "surface:workspace:channel" — always 3 positional parts to prevent collisions
  export function extractSurfaceKey(event: ResolvableEvent): string {
    const parts = [event.surface, event.workspace ?? "", event.channel ?? ""];
    return SurfaceKey.create(parts);
  }

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
