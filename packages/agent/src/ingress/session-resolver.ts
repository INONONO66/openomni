import { Session } from "@openomni/session";
import { SurfaceKey } from "@openomni/session";
import { EventEnvelope } from "../loop/envelope";
import { Message } from "@openomni/protocol";
import { EventProjector, DefaultEventProjector } from "./event-projector";

export namespace SessionResolver {
  export interface ResolveResult {
    session: Session.Info;
    isNew: boolean;
  }

  function extractSurfaceKey(source: EventEnvelope["source"]): string {
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
    const surfaceKey = extractSurfaceKey(event.source);
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
