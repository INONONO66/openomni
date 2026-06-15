import type { Extension } from "@openomni/protocol";
import type { RuntimeBindingExtension, RuntimeBindingTargets } from "./runtime-binding-types";

export function assertTargets(
  contributes: Extension.Contributes | undefined,
  targets: RuntimeBindingTargets,
): void {
  const missing = [
    ["agents", contributes?.agents, targets.agents],
    ["tools", contributes?.tools, targets.tools],
    ["skills", contributes?.skills, targets.skills],
    ["mcpServers", contributes?.mcpServers, targets.mcpServers],
    ["surfaces", contributes?.surfaces, targets.surfaces],
    ["middlewares", contributes?.middlewares, targets.middlewares],
  ]
    .filter(
      ([, values, target]) => Array.isArray(values) && values.length > 0 && target === undefined,
    )
    .map(([kind]) => kind);

  if (missing.length > 0) {
    throw new Error(`Missing runtime binding targets for: ${missing.join(", ")}`);
  }
}

export function hasContributions(contributes: Extension.Contributes): boolean {
  return (
    (contributes?.agents?.length ?? 0) > 0 ||
    (contributes?.tools?.length ?? 0) > 0 ||
    (contributes?.skills?.length ?? 0) > 0 ||
    (contributes?.mcpServers?.length ?? 0) > 0 ||
    (contributes?.surfaces?.length ?? 0) > 0 ||
    (contributes?.middlewares?.length ?? 0) > 0
  );
}

export function bindingKey(extension: RuntimeBindingExtension): string {
  return `${extension.id}@${extension.version}`;
}
