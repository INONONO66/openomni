import { expect } from "bun:test";
import { type z, ZodError } from "zod";

export function expectIssue(
  result: z.ZodSafeParseResult<unknown>,
  expected: { message?: string; path: string | PropertyKey[] },
): void {
  expect(result.success).toBe(false);
  if (result.success) throw new Error("Expected schema rejection");
  const issue = result.error.issues[0];
  if (expected.message !== undefined) expect(issue?.message).toBe(expected.message);
  if (typeof expected.path === "string") expect(issue?.path.join(".")).toBe(expected.path);
  else expect(issue?.path).toEqual(expected.path);
}

export function expectParseFailure(parse: () => unknown): void {
  expect(parse).toThrow(ZodError);
}
