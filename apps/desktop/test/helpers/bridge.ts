import type { DesktopApi, ShellCommand } from "../../src/preload/api";

export function commandBridge(
  listeners: Set<(command: ShellCommand) => void>,
  onSubscribe: () => void,
  onCloseWindow: () => void = () => undefined,
): DesktopApi {
  return {
    versions: { electron: "test", chrome: "test", node: "test" },
    gateway: () => Promise.resolve(undefined),
    closeWindow: onCloseWindow,
    onShellCommand: (listener) => {
      onSubscribe();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
