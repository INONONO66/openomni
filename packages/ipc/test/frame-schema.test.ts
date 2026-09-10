import { expect, test } from "bun:test";
import { FrameSchema } from "../src/frame-schema";
import { LineDecoder } from "../src/framing";

test("wire frames retain primitive entries, reserved keys and JSON numeric edge values", () => {
  const decoder = new LineDecoder();
  const result = decoder.push('[null,false,"entry",-0,1e400,-1e400,{"__proto__":1,"constructor":2}]\n');
  expect(result.malformed).toEqual([]);
  expect(result.frames).toEqual([
    [null, false, "entry", -0, Infinity, -Infinity, JSON.parse('{"__proto__":1,"constructor":2}')],
  ]);
});

test("wire validation is iterative for deeply nested parseable frames", () => {
  const depth = 20_000;
  const frame = `${"[".repeat(depth)}0${"]".repeat(depth)}\n`;
  const result = new LineDecoder().push(frame);
  expect(result.malformed).toEqual([]);
  expect(result.frames).toHaveLength(1);
});

test("wire schema refuses values that JSON.parse cannot produce without reading accessors", () => {
  const cycle = { child: {} };
  cycle.child = cycle;
  let reads = 0;
  const accessor = { get value() { reads += 1; return 1; } };
  for (const value of [undefined, NaN, 1n, Symbol("frame"), () => 1, new Date(), cycle, accessor,
    { [Symbol("field")]: 1 }, new Array<number>(1)]) {
    expect(FrameSchema.safeParse(value).success).toBe(false);
  }
  expect(reads).toBe(0);
});

test("schema failure marks only its own line malformed", () => {
  // A temporary non-JSON parser value exercises the schema rejection at the actual framing boundary.
  const parse = JSON.parse;
  JSON.parse = (text, reviver) => text === '"invalid-schema"' ? undefined : FrameSchema.parse(parse(text, reviver));
  try {
    expect(new LineDecoder().push('"before"\n"invalid-schema"\n"after"\n')).toEqual({
      frames: ["before", "after"], malformed: ['"invalid-schema"'],
    });
  } finally {
    JSON.parse = parse;
  }
});
