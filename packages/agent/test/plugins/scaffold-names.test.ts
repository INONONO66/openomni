/**
 * #1276: the four scaffold plugin modules export the capability name and
 * nothing else until #1252/#1254/#1255/#1256 fill them. Each name must equal
 * its directory name (the loader key later issues assume).
 */
import { expect, test } from "bun:test";
import { name as action } from "../../src/plugins/action";
import { name as alarm } from "../../src/plugins/alarm";
import { name as hook } from "../../src/plugins/hook";
import { name as tool } from "../../src/plugins/tool";

test("#1276 scaffold plugins export their directory name", () => {
  expect(action).toBe("action");
  expect(alarm).toBe("alarm");
  expect(hook).toBe("hook");
  expect(tool).toBe("tool");
});
