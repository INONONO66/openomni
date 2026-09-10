import type { attachMachineDaemon } from "@openomni/machines";

export function cellDaemonOptions(socketPath: string, machineId: string): Parameters<typeof attachMachineDaemon>[0] {
  return {
    socketPath,
    offer: {
      machineId,
      offeredCapabilities: ["kernel.py"],
      daemonVersion: "test",
      platform: "test",
      offeredAt: 0,
    },
  };
}
