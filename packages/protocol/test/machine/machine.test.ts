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

describe("Machine.WellKnownCapability", () => {
  test("exports the Python kernel and process sandbox capabilities", () => {
    expect(Machine.WellKnownCapability.pythonKernel).toBe("kernel.py");
    expect(Machine.WellKnownCapability.sandboxProcess).toBe("sandbox.process");
  });
});

describe("Machine.CapabilityId grammar", () => {
  test("accepts dot-namespaced lowercase ids", () => {
    for (const id of ["fs.read", "kernel.py", "screen.read", "input.write", "a.b_c.d0", "a.b"]) {
      expect(Machine.CapabilityId.safeParse(id).success).toBe(true);
    }
  });

  test("rejects single-segment, uppercase, and empty ids with the grammar message", () => {
    for (const id of ["fs", "Fs.read", "fs.", ".read", "", "fs..read", "fs.Read"]) {
      const result = Machine.CapabilityId.safeParse(id);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "capability id must be dot-namespaced lowercase (e.g. fs.read)",
        );
        expect(result.error.issues[0]?.path).toEqual([]);
      }
    }
  });

  test("rejects ids past 128 characters", () => {
    const result = Machine.CapabilityId.safeParse(`fs.${"a".repeat(130)}`);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("capability id must be at most 128 characters");
      expect(result.error.issues[0]?.path).toEqual([]);
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
      expect(result.error.issues[0]?.path.join(".")).toBe("allowedCapabilities");
    }
  });

  test("rejects an empty allowlist — an enrolled machine with no capability is a contradiction", () => {
    const result = Machine.Enrollment.safeParse({ ...enrollment, allowedCapabilities: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path.join(".")).toBe("allowedCapabilities");
      expect(result.error.issues[0]?.code).toBe("too_small");
    }
  });

  test("rejects unknown fields", () => {
    const result = Machine.Enrollment.safeParse({ ...enrollment, extra: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "extra"');
      expect(result.error.issues[0]?.path).toEqual([]);
    }
  });
});

describe("Machine.Offer", () => {
  test("accepts an empty offer — a daemon may attach able to do nothing yet", () => {
    expect(Machine.Offer.safeParse({ ...offer, offeredCapabilities: [] }).success).toBe(true);
  });

  test("rejects duplicate capabilities", () => {
    const result = Machine.Offer.safeParse({
      ...offer,
      offeredCapabilities: ["fs.read", "fs.read"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("capabilities must be unique");
      expect(result.error.issues[0]?.path.join(".")).toBe("offeredCapabilities");
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

  test("structurally duplicated offers still yield a set", () => {
    const outcome = Machine.effectiveCapabilities(enrollment, {
      ...offer,
      offeredCapabilities: [
        "fs.read",
        "fs.read",
      ] as string[] as Machine.Offer["offeredCapabilities"],
    });
    expect(outcome).toEqual({ kind: "effective", machineId: "mac-0", capabilities: ["fs.read"] });
  });

  test("mismatched machine ids refuse instead of intersecting", () => {
    const outcome = Machine.effectiveCapabilities(enrollment, { ...offer, machineId: "mac-1" });
    expect(outcome).toEqual({ kind: "machine_mismatch", enrolled: "mac-0", offered: "mac-1" });
  });
});

describe("machine.attached event payload", () => {
  test("rejects a duplicated effective set", () => {
    const result = Machine.Events.Attached.schema.safeParse({
      machineId: "mac-0",
      time: 1,
      effectiveCapabilities: ["fs.read", "fs.read"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("capabilities must be unique");
      expect(result.error.issues[0]?.path.join(".")).toBe("effectiveCapabilities");
    }
  });
});

describe("Machine.AttachResult", () => {
  test("attached refuses a duplicated effective set", () => {
    const result = Machine.AttachResult.safeParse({
      status: "attached",
      effectiveCapabilities: ["fs.read", "fs.read"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("capabilities must be unique");
      expect(result.error.issues[0]?.path.join(".")).toBe("effectiveCapabilities");
    }
  });

  test("refused accepts only the enrollment refusal vocabulary", () => {
    const result = Machine.AttachResult.safeParse({ status: "refused", reason: "bad_weather" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("invalid_value");
      expect(result.error.issues[0]?.path.join(".")).toBe("reason");
    }
  });

  test("refused carries no capability set", () => {
    const result = Machine.AttachResult.safeParse({
      status: "refused",
      reason: "machine_not_enrolled",
      effectiveCapabilities: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "effectiveCapabilities"');
      expect(result.error.issues[0]?.path).toEqual([]);
    }
  });
});
