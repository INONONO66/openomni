import { describe, expect, test } from "bun:test";
import { Machine } from "../../src/machine/index.js";

const enrollment = {
  machineId: "mac-0",
  name: "brain-mac",
  allowedCapabilities: ["fs.read", "fs.write", "shell.exec", "kernel.py"],
  enrolledAt: 1,
} satisfies Machine.Enrollment;

const offer = {
  machineId: "mac-0",
  offeredCapabilities: ["fs.read", "shell.exec", "screen.read"],
  daemonVersion: "0.1.0",
  platform: "darwin-arm64",
  offeredAt: 2,
} satisfies Machine.Offer;

describe("Machine.CapabilityId grammar", () => {
  test("accepts dot-namespaced lowercase ids", () => {
    for (const id of ["fs.read", "kernel.py", "screen.read", "input.write", "a.b_c.d0"]) {
      expect(Machine.CapabilityId.parse(id)).toBe(id);
    }
  });

  test("rejects single-segment, uppercase, and empty ids", () => {
    for (const id of ["fs", "Fs.read", "fs.", ".read", "", "fs..read", "fs.Read"]) {
      const result = Machine.CapabilityId.safeParse(id);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("dot-namespaced lowercase");
      }
    }
  });
});

describe("Machine.Enrollment", () => {
  test("rejects duplicate capabilities", () => {
    const result = Machine.Enrollment.safeParse({
      ...enrollment,
      allowedCapabilities: ["fs.read", "fs.read"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("capabilities must be unique");
    }
  });

  test("rejects an empty allowlist — an enrolled machine with no capability is a contradiction", () => {
    const result = Machine.Enrollment.safeParse({ ...enrollment, allowedCapabilities: [] });
    expect(result.success).toBe(false);
  });

  test("rejects unknown fields", () => {
    const result = Machine.Enrollment.safeParse({ ...enrollment, extra: true });
    expect(result.success).toBe(false);
  });
});

describe("Machine.Offer", () => {
  test("accepts an empty offer — a daemon may attach able to do nothing yet", () => {
    const result = Machine.Offer.safeParse({ ...offer, offeredCapabilities: [] });
    expect(result.success).toBe(true);
  });

  test("rejects duplicate capabilities", () => {
    const result = Machine.Offer.safeParse({
      ...offer,
      offeredCapabilities: ["fs.read", "fs.read"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("capabilities must be unique");
    }
  });
});

describe("Machine.effectiveCapabilities", () => {
  test("effective = enrollment ∩ offer, sorted ascending", () => {
    const outcome = Machine.effectiveCapabilities(enrollment, offer);
    expect(outcome).toEqual({
      kind: "effective",
      machineId: "mac-0",
      capabilities: ["fs.read", "shell.exec"],
    });
  });

  test("an offered capability the Owner never allowed is excluded", () => {
    const outcome = Machine.effectiveCapabilities(enrollment, {
      ...offer,
      offeredCapabilities: ["screen.read", "input.write"],
    });
    expect(outcome).toEqual({ kind: "effective", machineId: "mac-0", capabilities: [] });
  });

  test("mismatched machine ids refuse instead of intersecting", () => {
    const outcome = Machine.effectiveCapabilities(enrollment, { ...offer, machineId: "mac-1" });
    expect(outcome).toEqual({ kind: "machine_mismatch", enrolled: "mac-0", offered: "mac-1" });
  });
});
