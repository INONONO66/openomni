import { SurfaceKey } from "@openomni/session";

export namespace SurfaceStore {
  export function initialize(): void {}

  export function register(key: string, sessionId: string): void {
    SurfaceKey.register(key, sessionId);
  }

  export function lookup(key: string): string | undefined {
    return SurfaceKey.lookup(key);
  }
}
