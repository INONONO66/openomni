import { expect, test } from "bun:test";
import { join } from "node:path";
import type { SessionTransition } from "@openomni/protocol";
import { createProcessSessionTransport } from "../src/composition/process-session";
import { bounded } from "./helpers/protected-dispatch";

const CHILD = join(import.meta.dir, "fixtures/process-session-child.ts");

function transport(scenario: string, answer?: SessionTransition.Resolution | Error) {
  const committed: string[][] = [];
  const answers: SessionTransition.Answer[] = [];
  return {
    committed,
    answers,
    sessions: createProcessSessionTransport({
      command: [process.execPath, CHILD, scenario],
      worker: {
        dbPath: "unused.sqlite",
        model: { provider: "anthropic", id: "claude-opus-4-5" },
        apiKey: "process-key",
      },
      committed: (ids) => committed.push([...ids]),
      answer: async (value) => {
        answers.push(value);
        if (answer instanceof Error) throw answer;
        if (answer === undefined) throw new Error("no answer configured");
        // The second answer of a conversation is refused by the owner side.
        if (answers.length > 1) throw new Error("owner refused");
        return answer;
      },
    }),
  };
}

test("process transport relays the child's doorbell and both receipt outcomes", async () => {
  const f = transport("conversation", "resolved");
  const done = f.sessions.wake("worker");
  expect(f.sessions.wake("worker")).toBe(done);
  await bounded(done);
  expect(f.committed).toEqual([["child-a", "child-b"]]);
  expect(f.answers.map((answer) => answer.inputId)).toEqual(["first", "second"]);
  expect(f.answers[0]?.principal.principalId).toBe("worker");
});

test("an answer whose principal is not the authenticated child is refused", async () => {
  const f = transport("impostor", "resolved");
  await expect(bounded(f.sessions.wake("worker"))).rejects.toThrow(
    "process answer principal does not match its authenticated child",
  );
  expect(f.answers).toEqual([]);
});

test("a child exiting without settling surfaces its exit code", async () => {
  const f = transport("crash");
  await expect(bounded(f.sessions.wake("worker"))).rejects.toThrow(
    "session process exited 2: worker",
  );
});

test("closing the transport kills lingering children", async () => {
  const f = transport("linger");
  const done = f.sessions.wake("worker");
  const settled = done.then(
    () => "resolved" as const,
    (error: Error) => error.message,
  );
  await bounded(f.sessions.close());
  expect(await bounded(settled)).toMatch(/^session process exited /);
  expect(f.committed).toEqual([]);
});
