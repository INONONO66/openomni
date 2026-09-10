import { expect, it } from "bun:test";
import { expectFailedToolCommit, expectUncalledBudget } from "./helpers/execution-assertions";
import { recordingExecutor } from "./helpers/compiled-policy";
import { timedQueryTool } from "./helpers/query-tool";
import { createDispatcher } from "../src/tool-dispatcher";

it("shared budget assertions reject wrong reasons and unexpected provider calls", () => {
  const stopped = Object.assign(new Error("stopped"), { code: "agent_stop", reason: "budget" });
  expectUncalledBudget(stopped, 0);
  expect(() => expectUncalledBudget(stopped, 1)).toThrow();
  expect(() => expectUncalledBudget(Object.assign(new Error("other"), { code: "agent_stop", reason: "other" }), 0)).toThrow();
});

it("shared tool assertions remain sensitive to result and durable commit mutations", async () => {
  const recording = recordingExecutor();
  const dispatcher = createDispatcher([
    timedQueryTool("reject before timeout", async () => { throw new Error("failed"); }),
  ], { executor: recording.executor });
  const result = await dispatcher.execute({ id: "check", tool: "timed", input: {} }, { sessionId: "session-1", turnId: "turn-1" });
  expectFailedToolCommit(result, recording.committed);
  expect(() => expectFailedToolCommit({ ...result, isError: false }, recording.committed)).toThrow();
  expect(() => expectFailedToolCommit(result, [])).toThrow();
});
