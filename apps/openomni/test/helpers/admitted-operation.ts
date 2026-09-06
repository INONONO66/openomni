import { createDispatcher, defineTool } from "@openomni/agent";
import { z } from "zod";
import { executor } from "./executor";

/** Exercise an app one-shot consumer inside its real tool/executor context. */
export async function admittedOperation<T>(operation: () => Promise<T>): Promise<T> {
  let value: T | undefined;
  let failed: Error | undefined;
  const dispatcher = createDispatcher(
    [
      defineTool({
        name: "consumer",
        category: "execution",
        description: "fixture consumer",
        input: z.object({}),
        output: z.null(),
        visibility: { model: ["resident"], cell: [] },
        async execute() {
          try {
            value = await operation();
          } catch (error) {
            failed = error instanceof Error ? error : new Error(String(error));
            throw failed;
          }
          return null;
        },
        render: () => "",
      }),
    ],
    { executor },
  );
  await dispatcher.execute(
    { id: "consumer", tool: "consumer", input: {} },
    { sessionId: "test", turnId: "test-turn" },
  );
  if (failed !== undefined) throw failed;
  if (value === undefined) throw new Error("fixture operation returned undefined");
  return value;
}
