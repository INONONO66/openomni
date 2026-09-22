import { expect, test } from "bun:test";
import { Context } from "effect";
import { Codemode, createCodemode, ForeignFailure } from "../src/index";

test("the public codemode tag resolves the supplied native factory", () => {
  const service = { create: createCodemode };
  const context = Context.make(Codemode, service);
  expect(Codemode.key).toBe("@openomni/codemode/Codemode");
  expect(Context.get(context, Codemode)).toBe(service);
  expect(Context.get(context, Codemode).create).toBe(createCodemode);
  const error = new ForeignFailure({ operation: "cell.run", cause: "driver lost" });
  expect(error._tag).toBe("ForeignFailure");
  expect(error.message).toBe("driver lost");
});
