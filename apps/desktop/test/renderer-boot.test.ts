import { expect, test } from "bun:test";
import { RendererInvariantError } from "../src/renderer/errors";
import { installGlobals } from "./helpers";

/**
 * The renderer entry evaluates at import time, so the missing-root invariant
 * is exercised through a query-busted import: the specifier gets its own
 * module instance without disturbing the cached happy-path evaluation that
 * entry-wiring.test.ts pins.
 */
test("the renderer entry refuses to boot without its root element", async () => {
  const listeners = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const restoreGlobals = installGlobals({
    window: { ...listeners, localStorage: {} },
    document: {
      ...listeners,
      documentElement: { dataset: {} },
      getElementById: () => null,
    },
  });
  const specifier = `../src/renderer/main?${"without-root"}`;
  try {
    await expect(import(specifier)).rejects.toThrow(RendererInvariantError);
  } finally {
    restoreGlobals();
  }
});
