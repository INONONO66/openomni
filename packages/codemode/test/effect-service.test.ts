import { expect, test } from "bun:test";
import { Context, Effect } from "effect";
import { acquireSync, run } from "../../ipc/test/helpers/effects";
import { Codemode, createCodemode, ForeignFailure } from "../src/index";
import { Codemode as CodemodeService } from "../src/services";
import { CodemodeError } from "../src/errors";

test("the public codemode tag resolves the supplied native factory", async () => {
  const service = { create: createCodemode };
  const context = Context.make(Codemode, service);
  expect(CodemodeService.key).toBe("@openomni/codemode/Codemode");
  expect(new CodemodeError({ reason: "closed", message: "closed" })._tag).toBe("CodemodeError");

  expect(Context.get(context, Codemode)).toBe(service);
  expect(Context.get(context, Codemode).create).toBe(createCodemode);
  const error = new ForeignFailure({ operation: "cell.run", cause: "driver lost" });
  expect(error._tag).toBe("ForeignFailure");
  expect(error.message).toBe("driver lost");
  const { value: mode, close } = acquireSync(Context.get(context, Codemode).create());
  try {
    expect(await run(mode.callTool({ cellId: "missing", name: "read", arguments: {} }))).toEqual({
      status: "failed", error: "no tools are bound to cell missing",
    });
    expect(await run(Effect.flip(mode.cell.run("1", "tenant")))).toMatchObject({
      _tag: "CodemodeError", reason: "machines_not_bound",
    });
    expect((await run(Effect.flip(error)))._tag).toBe("ForeignFailure");
  } finally {
    await close();
  }
});
