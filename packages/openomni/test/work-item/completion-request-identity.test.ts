import { describe, expect, test } from "bun:test";
import type { WorkItem } from "@openomni/protocol";
import {
  completionReportReference,
  completionReportsMatch,
} from "../../src/work-item/completion-request-identity.js";

describe("completion report identity", () => {
  test("treats evidence references as an order-independent set", () => {
    const first: WorkItem.CompletionReport = {
      summary: "Canonical completion report.",
      claims: [
        {
          statement: "criterion one",
          evidenceIds: ["evidence:two", "evidence:one"],
        },
      ],
      caveats: [],
      followUps: [],
    };
    const reordered: WorkItem.CompletionReport = {
      ...first,
      claims: [
        {
          ...first.claims[0],
          evidenceIds: ["evidence:one", "evidence:two"],
        },
      ],
    };

    expect(completionReportsMatch(first, reordered)).toBe(true);
    expect(completionReportReference(first)).toBe(completionReportReference(reordered));
  });
});
