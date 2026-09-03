import { describe, expect, test } from "bun:test";
import type { DesktopApi } from "../src/preload/api";

describe("DesktopApi contract", () => {
  test("versions carry the three runtime identifiers", () => {
    const api: DesktopApi = { versions: { electron: "1", chrome: "2", node: "3" } };
    expect(Object.keys(api.versions).sort()).toEqual(["chrome", "electron", "node"]);
  });
});
