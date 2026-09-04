import type { Executor } from "@openomni/agent";

export const executor: Executor = {
  async run(_request, body) {
    return { terminal: "executed", value: await body() };
  },
};
