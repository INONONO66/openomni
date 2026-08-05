import { PolicyEngine } from "@openomni/policy";
import {
  createDefaultDispatchRuntime,
  type DefaultDispatchRuntime,
  type DefaultDispatchRuntimeOptions,
} from "@openomni/openomni";

export function createBootstrapDispatchRuntime(
  options: DefaultDispatchRuntimeOptions,
  createRuntime: typeof createDefaultDispatchRuntime = createDefaultDispatchRuntime,
): DefaultDispatchRuntime {
  return createRuntime({
    ...options,
    completionPolicyEngine: PolicyEngine.create(),
  });
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
