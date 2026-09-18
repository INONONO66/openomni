import type { SessionRunner, SessionRuntime } from "../../src/session-handle";
import { dispatchingRunner } from "./dispatching-runner";
import { completeModel } from "./mock-llm";

/** A tool-less completing runner whose model invocations are counted exactly. */
export function countingRunner(
  runtime: SessionRuntime,
  calls: { model: number },
  onModel: () => undefined = () => undefined,
): SessionRunner {
  return dispatchingRunner(
    [],
    () => runtime,
    async (input, sink) => {
      onModel();
      calls.model += 1;
      return completeModel(input, sink);
    },
  );
}
