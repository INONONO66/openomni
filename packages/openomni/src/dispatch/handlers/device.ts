import { Dispatch } from "@openomni/protocol";
import type { DeviceDispatchOwner } from "../owners.js";
import type { DispatchHandler, DispatchHandlerContext } from "../registry.js";

export interface DeviceDispatchHandlerOptions {
  readonly device?: DeviceDispatchOwner;
}

function requireDevice(device: DeviceDispatchOwner | undefined): DeviceDispatchOwner {
  if (!device) throw new Error("dispatch device handler requires device owner");
  return device;
}

function requireDeviceId(command: Dispatch.Command): string {
  if (command.target.kind !== "system") {
    throw new Error("device.command requires system target");
  }
  const deviceId = command.target.id ?? command.target.name;
  if (!deviceId) throw new Error("device.command requires target.id or target.name");
  return deviceId;
}

async function dispatchDeviceCommand(
  device: DeviceDispatchOwner,
  command: Dispatch.Command,
  context: DispatchHandlerContext | undefined,
): Promise<{ readonly output: unknown }> {
  const output = await device.dispatch({
    command,
    deviceId: requireDeviceId(command),
    payload: command.payload,
    ...(context?.signal ? { signal: context.signal } : {}),
    ...(context?.wait !== undefined ? { wait: context.wait } : {}),
    ...(context?.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
  });
  return { output };
}

export function createDeviceDispatchHandlers(
  options: DeviceDispatchHandlerOptions = {},
): Record<typeof Dispatch.Actions.DeviceCommand, DispatchHandler> {
  return {
    [Dispatch.Actions.DeviceCommand]: (command, context) =>
      dispatchDeviceCommand(requireDevice(options.device), command, context),
  };
}
