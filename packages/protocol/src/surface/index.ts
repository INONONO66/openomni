export type SurfaceChannelKind = "dm" | "group" | "channel" | "thread" | "chat";

export interface ParsedSurfaceAddress {
  readonly surface: string;
  readonly namespace: string;
  readonly kind: SurfaceChannelKind | undefined;
  readonly id: string | undefined;
  readonly threadId: string | undefined;
}

export namespace SurfaceAddress {
  export interface ChannelDescriptor {
    surface: string;
    namespace: string;
    kind: SurfaceChannelKind;
    id: string;
    threadId?: string;
  }

  function validateFormat(key: string): boolean {
    return key.includes(":");
  }

  export function create(parts: string[]): string {
    if (parts.length === 0) {
      throw new Error("SurfaceAddress parts cannot be empty");
    }

    const key = parts.join(":");
    if (!validateFormat(key)) {
      throw new Error(
        `Invalid surfaceAddress format: "${key}". Must include surface type prefix (e.g., "slack:...")`,
      );
    }

    return key;
  }

  const KNOWN_KINDS: ReadonlySet<string> = new Set<SurfaceChannelKind>([
    "dm",
    "group",
    "channel",
    "thread",
    "chat",
  ]);

  export function fromChannel(descriptor: ChannelDescriptor): string {
    const parts = [descriptor.surface, descriptor.namespace, descriptor.kind, descriptor.id];
    if (descriptor.threadId) {
      parts.push("thread", descriptor.threadId);
    }
    return create(parts);
  }

  export function parse(key: string): ParsedSurfaceAddress {
    const segments = key.split(":");
    const surface = segments[0] ?? "";
    const namespace = segments[1] ?? "";

    let kind: SurfaceChannelKind | undefined;
    let id: string | undefined;
    let threadId: string | undefined;

    for (let i = 2; i < segments.length; i++) {
      const segment = segments[i];
      if (segment == null) continue;
      if (KNOWN_KINDS.has(segment)) {
        if (segment === "thread") {
          threadId = segments[i + 1];
          i++;
        } else {
          kind = segment as SurfaceChannelKind;
          id = segments[i + 1];
          i++;
        }
      }
    }

    return { surface, namespace, kind, id, threadId };
  }
}
