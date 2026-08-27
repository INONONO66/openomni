import type { Model } from "@openomni/protocol";
import { describe, expect, test } from "bun:test";
import { buildAgentPrompt } from "../src/prompt/build";
import { RESIDENT_PRESET, type RolePreset } from "../src/prompt/roles";

const residentBase = [
  RESIDENT_PRESET.identity,
  RESIDENT_PRESET.mandate,
  RESIDENT_PRESET.policies,
  RESIDENT_PRESET.style,
]
  .filter((section): section is string => section !== undefined && section !== "")
  .join("\n\n");

describe("buildAgentPrompt", () => {
  test("is deterministic for the same preset and input", () => {
    const input = { memorySnapshot: "remember this" };

    expect(buildAgentPrompt(RESIDENT_PRESET, input)).toBe(
      buildAgentPrompt(RESIDENT_PRESET, input),
    );
  });

  test("keeps the base prefix stable across memory snapshots", () => {
    const base = buildAgentPrompt(RESIDENT_PRESET, {});

    expect(buildAgentPrompt(RESIDENT_PRESET, { memorySnapshot: "A" })).toStartWith(
      `${base}\n\n`,
    );
    expect(buildAgentPrompt(RESIDENT_PRESET, { memorySnapshot: "B" })).toStartWith(
      `${base}\n\n`,
    );
  });

  test("omits empty and undefined memory snapshots without a trailing separator", () => {
    const base = buildAgentPrompt(RESIDENT_PRESET);

    expect(base).toBe(residentBase);
    expect(buildAgentPrompt(RESIDENT_PRESET, { memorySnapshot: "" })).toBe(base);
    expect(buildAgentPrompt(RESIDENT_PRESET, { memorySnapshot: undefined })).toBe(base);
    expect(base.endsWith("\n")).toBe(false);
  });

  test("does not create empty paragraphs when optional sections are absent", () => {
    for (const memorySnapshot of [undefined, "memory"]) {
      expect(buildAgentPrompt(RESIDENT_PRESET, { memorySnapshot })).not.toContain("\n\n\n");
    }
  });

  test("places model tuning before memory and omits unavailable tuning", () => {
    const preset: RolePreset = {
      name: "tuned",
      identity: "identity",
      mandate: "mandate",
      tuning: (model) => (model.provider === "x" ? "x tuning" : undefined),
    };
    const xModel: Model.Ref = { provider: "x", id: "model" };
    const yModel: Model.Ref = { provider: "y", id: "model" };

    expect(buildAgentPrompt(preset, { model: xModel, memorySnapshot: "memory" })).toBe(
      [preset.identity, preset.mandate, preset.tuning?.(xModel), "memory"].join("\n\n"),
    );
    expect(buildAgentPrompt(preset, { model: yModel, memorySnapshot: "memory" })).toBe(
      [preset.identity, preset.mandate, "memory"].join("\n\n"),
    );
  });
});
