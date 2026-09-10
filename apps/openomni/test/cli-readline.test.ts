import { expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createCliDeps } from "../src/cli/main";
import { bounded } from "./helpers/protected-dispatch";

test.each([
  { secret: false, fallback: undefined },
  { secret: false, fallback: "default" },
  { secret: true, fallback: undefined },
])("readline adapter returns a terminal answer: %j", async (options) => {
  const input = new PassThrough();
  Object.defineProperty(input, "isTTY", { value: true });
  const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  if (descriptor === undefined) throw new Error("stdin descriptor missing");
  const prompted = Promise.withResolvers<void>();
  const output: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    prompted.resolve();
    return true;
  });
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  try {
    const answer = createCliDeps().ask("fixture", options);
    await bounded(prompted.promise);
    input.write("ANSWER_SENTINEL\n");
    expect(await bounded(answer)).toBe("ANSWER_SENTINEL");
    if (options.secret) expect(output.join("")).not.toContain("ANSWER_SENTINEL");
  } finally {
    Object.defineProperty(process, "stdin", descriptor);
    stdout.mockRestore();
    input.destroy();
  }
});
