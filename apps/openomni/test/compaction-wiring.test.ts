import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Bus } from "@openomni/telemetry";
import { loadConfig } from "../src/config";
import { createConfiguredCompactionPolicy } from "../src/index";

const KEYS = [
  "OPENOMNI_MODEL_PROVIDER",
  "OPENOMNI_MODEL_ID",
  "OPENOMNI_MODEL_API_KEY",
  "OPENOMNI_COMPACTION_SUMMARIZER",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.OPENOMNI_MODEL_PROVIDER = "fake";
  process.env.OPENOMNI_MODEL_ID = "resident-test";
  process.env.OPENOMNI_MODEL_API_KEY = "test-key";
  delete process.env.OPENOMNI_COMPACTION_SUMMARIZER;
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("compaction composition root", () => {
  it("wires onSummarize by default through loadConfig", () => {
    const registration = createConfiguredCompactionPolicy(loadConfig(), Bus).create();
    expect(registration.pointIds).toEqual(["run.turn.post", "run.completion.pre"]);
  });

  it("omits onSummarize when OPENOMNI_COMPACTION_SUMMARIZER=off", () => {
    process.env.OPENOMNI_COMPACTION_SUMMARIZER = "off";
    const registration = createConfiguredCompactionPolicy(loadConfig(), Bus).create();
    expect(registration.pointIds).toEqual(["run.completion.pre"]);
  });
});
