import type { attachMachineDaemon } from "@openomni/machines";
import { testIds } from "./test-entropy";

export function cellDaemonOptions(
  socketPath: string,
  machineId: string,
): Parameters<typeof attachMachineDaemon>[0] {
  return {
    socketPath,
    id: testIds(`cell-daemon-${machineId}`),
    offer: {
      machineId,
      offeredCapabilities: ["kernel.py"],
      daemonVersion: "test",
      platform: "test",
      offeredAt: 0,
    },
  };
}
