import { describe, expect, test } from "bun:test";
import { validateSideEffectRules } from "../lint-side-effects";

const processorPath = "packages/llm/src/processor/index.ts";

describe("side-effect ordering gate", () => {
  test("requires projected sink binding before processor emission", () => {
    const bind =
      "const sink = createProjectedSink(events, configuredSink, sessionID, trace.traceId);";
    const emit = "sink.onMessage(message);";
    expect(validateSideEffectRules(processorPath, `${bind}\n${emit}`)).toEqual([]);
    expect(validateSideEffectRules(processorPath, `${emit}\n${bind}`)).toHaveLength(1);
    expect(validateSideEffectRules(processorPath, bind)).toHaveLength(1);
  });
});
