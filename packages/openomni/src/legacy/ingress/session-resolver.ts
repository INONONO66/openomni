import { Session } from "@openomni/session";
import { SurfaceKey } from "@openomni/session";
import { EventEnvelope } from "../dispatch";
import { Message } from "@openomni/protocol";
import { EventProjector, DefaultEventProjector } from "./event-projector";

export namespace SessionResolver {
  export interface ResolveResult {
    session: Session.Info;
    isNew: boolean;
  }

  export function extractSurfaceKey(
    source: EventEnvelope["source"],
    meta?: Record<string, unknown>,
  ): string {
    const channelKind = meta?.channelKind as string | undefined;
    const channelId = meta?.channelId as string | undefined;
    const threadId = meta?.threadId as string | undefined;

    if (source.id && channelKind && channelId) {
      const parts = [source.type, source.id, channelKind, channelId];
      if (threadId) {
        parts.push("thread", threadId);
      }
      return parts.join(":");
    }

    if (source.id) {
      return `${source.type}:${source.id}`;
    }
    return source.type;
  }

  export function resolve(
    event: EventEnvelope,
    defaultModel: { providerID: string; modelID: string } = {
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet-20241022",
    },
    projector: EventProjector = DefaultEventProjector,
  ): ResolveResult {
    const surfaceKey = extractSurfaceKey(event.source, event.meta);
    const existingSessionId = SurfaceKey.lookup(surfaceKey);

    let session: Session.Info;
    let isNew = false;

    if (existingSessionId) {
      const existing = Session.get(existingSessionId);
      if (!existing) {
        session = Session.create({
          title: `Session from ${event.source.type}`,
          model: defaultModel,
        });
        SurfaceKey.register(surfaceKey, session.id);
        isNew = true;
      } else {
        session = existing;
        isNew = false;
      }
    } else {
      session = Session.create({
        title: `Session from ${event.source.type}`,
        model: defaultModel,
      });
      SurfaceKey.register(surfaceKey, session.id);
      isNew = true;
    }

    projector.project(event, session.id, defaultModel);

    return { session, isNew };
  }
}
