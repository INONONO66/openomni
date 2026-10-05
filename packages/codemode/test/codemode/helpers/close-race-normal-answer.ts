/**
 * Child-process reproduction of the #1293 r3 HIGH: a NORMALLY resolving tool
 * callback racing close(). It runs in its own bun process so the runtime's
 * unhandled-error detection is the assertion surface: before the fix the late
 * answer reached stdin.write() on the ended stream and the asynchronous
 * ERR_STREAM_WRITE_AFTER_END escaped every Effect boundary, crashing the
 * process (exit 1) even though close() and the cell both settled. Event
 * synchronization, no sleeps: the ready tool_call frame proves the cell is
 * blocked on the host before close() is invoked, and the answer is released
 * only after close() is in flight, so its delivery races the stdin EOF.
 * Whichever side wins, the contract is the same - the driver-side call either
 * receives the answer or fails via EOF (caught as ToolError), the cell
 * completes, the drained driver runs its cleanup and acks - so the parent
 * asserts exit 0 plus the CLOSE_OK / CELL completed markers.
 */
import { PythonKernel } from "./native";

const kernel = new PythonKernel();
const toolCalled = Promise.withResolvers<void>();
const released = Promise.withResolvers<void>();
const running = kernel.run(
  {
    cellId: "active-close-normal-answer",
    code: ["try:", "    tool.ready()", "except ToolError:", "    pass", "'answered'"].join("\n"),
    timeoutMs: 15_000,
  },
  () => {
    toolCalled.resolve();
    return released.promise.then(() => ({ status: "completed", value: null }) as const);
  },
);
await toolCalled.promise;
const closing = kernel.close();
released.resolve();
await closing;
console.log("CLOSE_OK");
console.log("CELL", (await running).status);
