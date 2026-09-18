import { expect, test } from "bun:test";
import { decodeJson } from "./quality-json";

test("shared JSON parser rejects executable, ambiguous and nonfinite syntax", () => {
  expect(decodeJson('{"value":[true,false,null,-1.5,"text"]}')).toEqual({ value: [true, false, null, -1.5, "text"] });
  for (const input of ['{"a":1,"a":2}', '{"a":undefined}', '{"a":1,}', "[1,]", "1 trailing", "1e400", "/* comment */ 1", '"\u0001"', '"\\x"', "{a:1}", "'value'", "", "{", "01", "1.", ".5", "+1", "[,1]", "[1 2]", '{"a" 1}', '"\\u12"'])
    expect(() => decodeJson(input)).toThrow();
});

test("shared JSON parser decodes nested receipts to the built-in parser's value", () => {
  const input = '{"a":{"b":[1,2,{"c":null}]},"d":"x\\u00e9\\n\\"","e":-0.5e3,"f":[],"g":{},"h":[[[]]]}';
  expect(decodeJson(input)).toEqual(JSON.parse(input));
  expect(decodeJson("  [ ]  ")).toEqual([]);
  expect(decodeJson("-0")).toBe(-0);
});


test("large escaped native receipt strings are not rejected by a regex backtracking limit", () => {
  const value = "\\n".repeat(1_000_000);
  const result = decodeJson(JSON.stringify({ value }));
  expect(result).toEqual({ value });
});
