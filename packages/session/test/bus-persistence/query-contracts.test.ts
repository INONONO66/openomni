import { describe, expect, test } from "bun:test";
import { BusQuery } from "../../src/bus-persistence/query.js";

describe("BusQuery public contracts", () => {
  test("exposes public schema contracts", () => {
    expect(BusQuery.ChainIntegrityResult.parse({ valid: true, totalVerified: 0 })).toEqual({
      valid: true,
      totalVerified: 0,
    });
  });
});
