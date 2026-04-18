import { describe, it, expect } from "bun:test";
import {
  requireString,
  optionalString,
  optionalBoolean,
  optionalPositiveInteger,
  optionalPositiveNumber,
} from "./input.js";

describe("requireString", () => {
  it("returns value when key is a non-empty string", () => {
    expect(requireString({ name: "alice" }, "name")).toBe("alice");
  });

  it("throws when key is missing", () => {
    expect(() => requireString({}, "name")).toThrow("name must be a non-empty string");
  });

  it("throws when value is an empty string", () => {
    expect(() => requireString({ name: "" }, "name")).toThrow("name must be a non-empty string");
  });

  it("throws when value is not a string", () => {
    expect(() => requireString({ count: 42 }, "count")).toThrow("count must be a non-empty string");
    expect(() => requireString({ flag: true }, "flag")).toThrow("flag must be a non-empty string");
    expect(() => requireString({ obj: {} }, "obj")).toThrow("obj must be a non-empty string");
  });

  it("throws when value is null", () => {
    expect(() => requireString({ name: null }, "name")).toThrow("name must be a non-empty string");
  });
});

describe("optionalString", () => {
  it("returns undefined when key is absent", () => {
    expect(optionalString({}, "name")).toBeUndefined();
  });

  it("returns the string when present and non-empty", () => {
    expect(optionalString({ name: "bob" }, "name")).toBe("bob");
  });

  it("throws when value is present but empty", () => {
    expect(() => optionalString({ name: "" }, "name")).toThrow("name must be a non-empty string");
  });

  it("throws when value is present but not a string", () => {
    expect(() => optionalString({ name: 123 }, "name")).toThrow("name must be a non-empty string");
  });
});

describe("optionalBoolean", () => {
  it("returns undefined when key is absent", () => {
    expect(optionalBoolean({}, "flag")).toBeUndefined();
  });

  it("returns true when value is true", () => {
    expect(optionalBoolean({ flag: true }, "flag")).toBe(true);
  });

  it("returns false when value is false", () => {
    expect(optionalBoolean({ flag: false }, "flag")).toBe(false);
  });

  it("throws when value is a string", () => {
    expect(() => optionalBoolean({ flag: "true" }, "flag")).toThrow("flag must be a boolean");
  });

  it("throws when value is a number", () => {
    expect(() => optionalBoolean({ flag: 1 }, "flag")).toThrow("flag must be a boolean");
  });
});

describe("optionalPositiveInteger", () => {
  it("returns undefined when key is absent", () => {
    expect(optionalPositiveInteger({}, "limit")).toBeUndefined();
  });

  it("returns value for a positive integer", () => {
    expect(optionalPositiveInteger({ limit: 5 }, "limit")).toBe(5);
    expect(optionalPositiveInteger({ limit: 1 }, "limit")).toBe(1);
  });

  it("throws for zero", () => {
    expect(() => optionalPositiveInteger({ limit: 0 }, "limit")).toThrow(
      "limit must be a positive integer",
    );
  });

  it("throws for negative integer", () => {
    expect(() => optionalPositiveInteger({ limit: -3 }, "limit")).toThrow(
      "limit must be a positive integer",
    );
  });

  it("throws for non-integer number", () => {
    expect(() => optionalPositiveInteger({ limit: 1.5 }, "limit")).toThrow(
      "limit must be a positive integer",
    );
  });

  it("throws for string value", () => {
    expect(() => optionalPositiveInteger({ limit: "5" }, "limit")).toThrow(
      "limit must be a positive integer",
    );
  });
});

describe("optionalPositiveNumber", () => {
  it("returns undefined when key is absent", () => {
    expect(optionalPositiveNumber({}, "temperature")).toBeUndefined();
  });

  it("returns value for a positive number", () => {
    expect(optionalPositiveNumber({ temperature: 0.7 }, "temperature")).toBe(0.7);
    expect(optionalPositiveNumber({ temperature: 1 }, "temperature")).toBe(1);
  });

  it("accepts non-integer positive numbers", () => {
    expect(optionalPositiveNumber({ temperature: 2.5 }, "temperature")).toBe(2.5);
  });

  it("throws for zero", () => {
    expect(() => optionalPositiveNumber({ temperature: 0 }, "temperature")).toThrow(
      "temperature must be a positive number",
    );
  });

  it("throws for negative number", () => {
    expect(() => optionalPositiveNumber({ temperature: -0.1 }, "temperature")).toThrow(
      "temperature must be a positive number",
    );
  });

  it("throws for Infinity", () => {
    expect(() => optionalPositiveNumber({ temperature: Infinity }, "temperature")).toThrow(
      "temperature must be a positive number",
    );
  });

  it("throws for NaN", () => {
    expect(() => optionalPositiveNumber({ temperature: NaN }, "temperature")).toThrow(
      "temperature must be a positive number",
    );
  });

  it("throws for string value", () => {
    expect(() => optionalPositiveNumber({ temperature: "0.7" }, "temperature")).toThrow(
      "temperature must be a positive number",
    );
  });
});
