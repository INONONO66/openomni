import { describe, test, expect } from "bun:test";
import { z, ZodError } from "zod";

import { NamedError } from "../src/error/index.js";

describe("NamedError.create", () => {
  const MyError = NamedError.create(
    "MyError",
    z.object({
      message: z.string(),
      detail: z.number(),
    }),
  );

  test("returns a class with static schema helpers", () => {
    expect(typeof MyError).toBe("function");
    expect(MyError.name).toBe("MyError");
    expect(MyError.Schema).toBeDefined();
    expect(MyError.isInstance).toBeDefined();
  });

  test("creates instances with message and data from payload", () => {
    const error = new MyError({ message: "boom", detail: 42 });

    expect(error.name).toBe("MyError");
    expect(error.message).toBe("boom");
    expect(error.data).toEqual({ message: "boom", detail: 42 });
  });

  test("falls back to the error name when payload has no message", () => {
    const NoMessageError = NamedError.create(
      "NoMessageError",
      z.object({
        detail: z.number(),
      }),
    );

    const error = new NoMessageError({ detail: 7 });

    expect(error.message).toBe("NoMessageError");
    expect(error.data).toEqual({ detail: 7 });
  });

  test("returns the schema and object shape", () => {
    const error = new MyError({ message: "shape", detail: 1 });

    expect(error.schema()).toBe(MyError.Schema);
    expect(error.toObject()).toEqual({
      name: "MyError",
      data: { message: "shape", detail: 1 },
    });
  });

  test("sets cause when provided", () => {
    const cause = new Error("cause");
    const error = new MyError({ message: "boom", detail: 1 }, { cause });

    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });

  test.each([null, false, 0, ""])("retains an explicitly provided falsy cause: %p", (cause) => {
    const error = new MyError({ message: "boom", detail: 1 }, { cause });

    expect(Object.hasOwn(error, "cause")).toBe(true);
    expect(Reflect.get(error, "cause")).toBe(cause);
  });

  test("distinguishes omitted cause from an explicitly present undefined cause", () => {
    const omitted = new MyError({ message: "omitted", detail: 1 });
    const explicit = new MyError({ message: "explicit", detail: 1 }, { cause: undefined });

    expect(Object.hasOwn(omitted, "cause")).toBe(false);
    expect(Object.hasOwn(explicit, "cause")).toBe(true);
    expect(Reflect.get(explicit, "cause")).toBeUndefined();
  });

  test("isInstance matches real instances", () => {
    expect(MyError.isInstance(new MyError({ message: "ok", detail: 1 }))).toBe(true);
  });

  test("isInstance rejects null", () => {
    expect(MyError.isInstance(null)).toBe(false);
  });

  test("isInstance rejects plain objects with the same name", () => {
    expect(MyError.isInstance({ name: "MyError" })).toBe(false);
  });

  test("isInstance rejects plain objects with a different name", () => {
    expect(MyError.isInstance({ name: "OtherError" })).toBe(false);
  });

  test("isInstance recognizes instances from an independent copy of the class", () => {
    // bun resolves each workspace symlink to @openomni/protocol separately,
    // so one process can hold two copies of the same generated class; the
    // guard must match across copies. A second create() with the same name
    // reproduces that dual-load shape.
    const CopyError = NamedError.create(
      "MyError",
      z.object({ message: z.string(), detail: z.number() }),
    );
    expect(MyError.isInstance(new CopyError({ message: "ok", detail: 1 }))).toBe(true);
  });

  test("isInstance rejects a real Error whose name merely matches", () => {
    const impostor = new Error("boom");
    impostor.name = "MyError";
    expect(MyError.isInstance(impostor)).toBe(false);
  });
});

describe("NamedError.Unknown", () => {
  test("uses the built-in name and message field", () => {
    const error = new NamedError.Unknown({ message: "oops" });

    expect(error.name).toBe("UnknownError");
    expect(error.message).toBe("oops");
    expect(error.toObject()).toEqual({
      name: "UnknownError",
      data: { message: "oops" },
    });
  });

  test("parses valid objects and rejects missing message", () => {
    expect(
      NamedError.Unknown.Schema.parse({
        name: "UnknownError",
        data: { message: "test" },
      }),
    ).toEqual({
      name: "UnknownError",
      data: { message: "test" },
    });

    expect(() =>
      NamedError.Unknown.Schema.parse({
        name: "UnknownError",
        data: {},
      }),
    ).toThrow(ZodError);
  });
});

// #500 C3: the APIError suite moved to packages/llm/test/error.test.ts with the
// schema — llm is its home now.

describe("NamedError.create with non-object data", () => {
  test("falls back to the class name for string payloads", () => {
    const StrError = NamedError.create("StrError", z.string());
    const error = new StrError("just a string");

    expect(error.message).toBe("StrError");
    expect(error.data).toBe("just a string");
    expect(error.toObject()).toEqual({
      name: "StrError",
      data: "just a string",
    });
  });
});

test("isInstance refuses a same-named error whose data violates this factory's schema", () => {
  const A = NamedError.create("SharedName", z.object({ code: z.string() }));
  const B = NamedError.create("SharedName", z.object({ count: z.number() }));
  const fromB = new B({ count: 3 });
  // Same brand value (name), incompatible payload contract: the guard's type
  // predicate must not admit it, or consumers read absent fields.
  expect(A.isInstance(fromB)).toBe(false);
  expect(B.isInstance(fromB)).toBe(true);
  expect(A.isInstance(new A({ code: "ok" }))).toBe(true);
});
