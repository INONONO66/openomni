import { describe, expect, test } from "bun:test";
import {
  parseWindowBounds,
  serializeWindowBounds,
  WINDOW_DEFAULT,
} from "../src/main/window-bounds";

describe("window bounds at the file boundary", () => {
  test("Given no file, When parsed, Then the default size with no position", () => {
    expect(parseWindowBounds(null)).toEqual(WINDOW_DEFAULT);
  });

  test("Given malformed or undersized JSON, When parsed, Then the default", () => {
    expect(parseWindowBounds("{nope")).toEqual(WINDOW_DEFAULT);
    expect(parseWindowBounds('{"x":0,"y":0,"width":100,"height":100}')).toEqual(WINDOW_DEFAULT);
  });

  test("Given valid bounds, When serialized and parsed, Then they round-trip", () => {
    const bounds = { x: 10, y: 20, width: 900, height: 700 };
    expect(parseWindowBounds(serializeWindowBounds(bounds))).toEqual(bounds);
  });
});
