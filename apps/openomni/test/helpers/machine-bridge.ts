import { createCodemode } from "@openomni/codemode";
import { attachMachineDaemon, createMachineHost } from "@openomni/machines";
import type { Machine } from "@openomni/protocol";

export function bridgeHost(
  socketPath: string,
  options: { callTool?: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult> } = {},
) {
  return createMachineHost({
    socketPath,
    enrollment: () => ({
      name: "workstation",
      machineId: "m-1",
      allowedCapabilities: ["kernel.py"],
      enrolledAt: 1000,
    }),
    events: { publish: () => undefined },
    now: () => 5000,
    ...options,
  });
}

export async function bridgeProbe(socketPath: string) {
  let reached = false;
  const host = await bridgeHost(socketPath, {
    callTool: () => {
      reached = true;
      return Promise.resolve({ status: "completed", value: "ran" });
    },
  });
  return { host, reached: () => reached };
}

export function bridgeOffer(): Machine.Offer {
  return {
    machineId: "m-1",
    daemonVersion: "0.1.0",
    platform: "darwin",
    offeredCapabilities: ["kernel.py"],
    offeredAt: 2000,
  };
}

export function bridgeDaemon(socketPath: string) {
  return attachMachineDaemon({ runner: createCodemode().runner, socketPath, offer: bridgeOffer() });
}
