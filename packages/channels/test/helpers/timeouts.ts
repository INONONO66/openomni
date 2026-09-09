import { spyOn } from "bun:test";

/** Subscribe before the operation; fire each requested timeout explicitly, without wall-clock waits. */
export function controlledTimeouts() {
  let scheduled = Promise.withResolvers<() => void>();
  const handle = setTimeout(() => undefined, 0);
  clearTimeout(handle);
  const delays: number[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign(
      (callback: Parameters<typeof setTimeout>[0], delay?: number) => {
        delays.push(delay ?? 0);
        scheduled.resolve(() => callback());
        return handle;
      },
      { __promisify__: setTimeout.__promisify__ },
    ),
  );
  return {
    delays,
    async fireNext(): Promise<void> {
      const fire = await scheduled.promise;
      scheduled = Promise.withResolvers<() => void>();
      fire();
    },
    restore: () => timer.mockRestore(),
  };
}
