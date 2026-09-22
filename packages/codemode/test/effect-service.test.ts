import { expect, test } from "bun:test";
import { Context } from "effect";
import { Codemode, createCodemode, ForeignFailure } from "../src/index";
import { Codemode as CodemodeService } from "../src/services";
import { CodemodeError } from "../src/errors";

test("the public codemode tag resolves the supplied native factory", () => {
  const service = { create: createCodemode };
  const context = Context.make(Codemode, service);
  expect(CodemodeService.key).toBe("@openomni/codemode/Codemode");
  expect(new CodemodeError({ reason: "closed", message: "closed" })._tag).toBe("CodemodeError");

  expect(Context.get(context, Codemode)).toBe(service);
  expect(Context.get(context, Codemode).create).toBe(createCodemode);
  const error = new ForeignFailure({ operation: "cell.run", cause: "driver lost" });
  expect(error._tag).toBe("ForeignFailure");
  expect(error.message).toBe("driver lost");
});
