import type { AgentToolProvider, SystemToolProvider, CoordinatorLike } from "@openomni/openomni";
import type { McpToolProvider } from "../tool/mcp";
import type { CustomToolProvider } from "../tool/custom";

type Config = {
  readonly systemProvider: SystemToolProvider;
  readonly agentProvider: AgentToolProvider;
  readonly mcpProvider: McpToolProvider;
  readonly customProvider?: CustomToolProvider;
  readonly workspaceRoot?: string;
};

export namespace LocalRunner {
  export function create(config: Config): CoordinatorLike {
    void config;
    return {
      dispatch: async () => {
        throw new Error("LocalRunner is disabled; use coordinator execution");
      },
    };
  }
}
