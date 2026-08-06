import { PolicyEngine } from "@openomni/policy";
import {
  createDefaultDispatchRuntime,
  type DefaultDispatchRuntime,
  type DefaultDispatchRuntimeOptions,
} from "@openomni/openomni";
import { runBootstrapRecovery, type BootstrapRecoveryInput } from "./recovery";

function createBootstrapDispatchRuntime(
  options: DefaultDispatchRuntimeOptions,
  createRuntime: typeof createDefaultDispatchRuntime = createDefaultDispatchRuntime,
): DefaultDispatchRuntime {
  return createRuntime({
    ...options,
    completionPolicyEngine: options.completionPolicyEngine ?? PolicyEngine.create(),
  });
}

export function createBootstrapDispatchContext(
  options: DefaultDispatchRuntimeOptions,
  createRuntime: typeof createDefaultDispatchRuntime = createDefaultDispatchRuntime,
  recover: typeof runBootstrapRecovery = runBootstrapRecovery,
): Readonly<{
  runtime: DefaultDispatchRuntime;
  recover(input: Omit<BootstrapRecoveryInput, "completionRuntime">): Promise<void>;
}> {
  const runtime = createBootstrapDispatchRuntime(options, createRuntime);
  return {
    runtime,
    recover: (input) => recover({ ...input, completionRuntime: runtime }),
  };
}

type InboundSurface = Readonly<{ start(): Promise<void> | void }>;

export async function startInboundSurfacesAfterRecovery<T>(
  input: Readonly<{
    recover(): Promise<void>;
    createServer(): T;
    channels: readonly InboundSurface[];
  }>,
): Promise<T> {
  await input.recover();
  const server = input.createServer();
  await Promise.all(input.channels.map((channel) => channel.start()));
  return server;
}
