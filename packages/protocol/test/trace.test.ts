import { expect, test } from "bun:test";
import { traceIdFromUuid } from "../src/index.js";

test("traceIdFromUuid removes UUID separators without changing hex digits", () => {
  expect(traceIdFromUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(
    "123e4567e89b12d3a456426614174000",
  );
});
