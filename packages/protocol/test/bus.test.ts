import { describe, expect, test } from "bun:test";
import { z, ZodError } from "zod";
import { BusEvent } from "../src/bus/index.js";

describe("BusEvent.define", () => {
  const schema = z.object({
    id: z.string().min(1),
    count: z.number().int().nonnegative(),
  });

  test("returns a descriptor with name and schema", () => {
    const descriptor = BusEvent.define("bus:event", schema);

    expect(descriptor).toEqual({
      name: "bus:event",
      schema,
    });
  });

  test("preserves the provided name", () => {
    const descriptor = BusEvent.define("bus:event", schema);

    expect(descriptor.name).toBe("bus:event");
  });

  test("preserves the schema reference", () => {
    const descriptor = BusEvent.define("bus:event", schema);

    expect(descriptor.schema).toBe(schema);
  });

  test("parses valid payloads", () => {
    const descriptor = BusEvent.define("bus:event", schema);

    expect(descriptor.schema.parse({ id: "abc", count: 3 })).toEqual({
      id: "abc",
      count: 3,
    });
  });

  test("throws for invalid payloads", () => {
    const descriptor = BusEvent.define("bus:event", schema);

    expect(() => descriptor.schema.parse({ id: "", count: -1 })).toThrow(ZodError);
  });

  test("allows an empty string name", () => {
    const descriptor = BusEvent.define("", schema);

    expect(descriptor.name).toBe("");
    expect(descriptor.schema).toBe(schema);
  });
});
