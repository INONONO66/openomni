export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
class JsonFailure {
  constructor(readonly message: string) {}
}
function invalid(message: string): never { throw new JsonFailure(message); }
// A strict single-pass decoder: one linear scan of the input and one allocation
// per value. Receipts reach a hundred megabytes; routing them through a syntax
// tree and a compiler program peaked above ten gigabytes per decode.
// Receipts nest a few levels deep; anything deeper is rejected as a typed
// failure before the recursive descent could exhaust the stack.
const MAX_DEPTH = 256;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WHITESPACE = /[ \t\n\r]*/y;
export function decodeJson(input: string): Json {
  let index = 0;
  let depth = 0;
  const skip = (): void => { WHITESPACE.lastIndex = index; WHITESPACE.exec(input); index = WHITESPACE.lastIndex; };
  const literal = (token: string, value: Json): Json => { if (!input.startsWith(token, index)) invalid("non-JSON value"); index += token.length; return value; };
  const escapeSequence = (): void => {
    const escaped = input[++index];
    if (escaped === "u") {
      if (!/^[0-9a-fA-F]{4}$/.test(input.slice(index + 1, index + 5))) invalid("invalid Unicode escape");
      index += 4;
    } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) invalid("invalid JSON escape");
  };
  const string = (): string => {
    const start = index++;
    for (; ; index++) {
      const code = input.charCodeAt(index);
      if (Number.isNaN(code) || code < 32) invalid("invalid JSON string character");
      if (code === 34) break;
      if (code === 92) escapeSequence();
    }
    return JSON.parse(input.slice(start, ++index)) as string;
  };
  const number = (): number => {
    NUMBER.lastIndex = index;
    const match = NUMBER.exec(input);
    if (!match) invalid("invalid JSON number");
    index = NUMBER.lastIndex;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) invalid("invalid JSON number");
    return value;
  };
  const enter = (): void => { if (++depth > MAX_DEPTH) invalid("JSON nesting too deep"); };
  const array = (): Json[] => {
    const values: Json[] = [];
    enter();
    index++;
    skip();
    if (input[index] === "]") { index++; depth--; return values; }
    for (; ; index++) {
      values.push(value());
      skip();
      if (input[index] === "]") { index++; depth--; return values; }
      if (input[index] !== ",") invalid("malformed JSON");
    }
  };
  const object = (): Json => {
    const entries: [string, Json][] = [];
    const keys = new Set<string>();
    enter();
    index++;
    skip();
    if (input[index] === "}") { index++; depth--; return Object.fromEntries(entries); }
    for (; ; index++) {
      skip();
      if (input[index] !== '"') invalid("invalid JSON key");
      const key = string();
      if (keys.has(key)) invalid("duplicate JSON key");
      keys.add(key);
      skip();
      if (input[index++] !== ":") invalid("malformed JSON");
      entries.push([key, value()]);
      skip();
      if (input[index] === "}") { index++; depth--; return Object.fromEntries(entries); }
      if (input[index] !== ",") invalid("malformed JSON");
    }
  };
  function value(): Json {
    skip();
    switch (input[index]) {
      case '"': return string();
      case "{": return object();
      case "[": return array();
      case "t": return literal("true", true);
      case "f": return literal("false", false);
      case "n": return literal("null", null);
      default: return number();
    }
  }
  const result = value();
  skip();
  if (index !== input.length) invalid("expected one JSON value");
  return result;
}
