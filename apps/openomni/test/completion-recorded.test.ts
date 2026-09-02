import { expect, test } from "bun:test";
import { WorkItemStore } from "@openomni/ledger";
import { completeWorkTool } from "../src/tools/mutation/work-items";
import { modelToolOutput } from "./helpers/tool-dispatch";
import type { CompletionJudgment, CompletionPort } from "../src/work-item/completion";
import { validateCompletionTerminalLinkage } from "../src/work-item/terminal-linkage";
import { recordedCompletionSuite } from "./helpers/recorded-completion";

const suite = recordedCompletionSuite();
const RESIDENT = { role: "resident", depth: 0, sessionId: "completion-recorded" } as const;

test("completion inspection exposes verifier result ids for recorded selection", async () => {
  // Given: a verifier has durably recorded criterion results.
  const scope = await suite.fixture();

  // When: the Resident inspects that WorkItem.
  const summary = scope.completion.inspect(scope.workItemId);

  // Then: machine-consumed ids and verdicts are selectable without transcript prose.
  expect(summary?.recordedResults).toEqual(
    scope.item.completionFacts.results.map(({ id, criterionId, value, basisRef }) => ({
      id,
      criterionId,
      value,
      verifierRef: "verifier:command.v1:dg-recorded",
      basisRef,
      invalidated: false,
    })),
  );
});

test("completion admits verifier-recorded results without restating their checks", async () => {
  // Given: verified results and their observation/evidence chain are durable.
  const scope = await suite.fixture();
  const judgments: readonly CompletionJudgment[] = scope.item.completionFacts.results.map(
    (result) => ({ criterionId: result.criterionId, value: "recorded", resultId: result.id }),
  );

  // When: completion selects those durable results by id.
  const outcome = await scope.completion.complete({ workItemId: scope.workItemId, judgments });

  // Then: the existing admission consumes, but does not re-propose, the results.
  expect(outcome).toEqual({ admitted: true, workItemId: scope.workItemId });
  const completed = WorkItemStore.get(scope.workItemId);
  expect(completed?.completionFacts.admissions.at(-1)).toMatchObject({
    effectiveResultIds: scope.item.completionFacts.results.map(({ id }) => id),
    proposedFactIds: { results: [] },
    reasonCodes: expect.arrayContaining(["verifier_recorded_results"]),
  });
  expect(completed?.completionReport?.claims[0]?.evidenceIds).toEqual([
    "evidence:verifier:dg-recorded:criterion-0",
  ]);
  expect(
    completed === undefined ? false : validateCompletionTerminalLinkage(completed).success,
  ).toBe(true);
});

test("complete_work forwards a recorded result id without adding check prose", async () => {
  // Given: the completion port records the machine-consumed request it receives.
  let received: Parameters<CompletionPort["complete"]>[0] | undefined;
  const port: CompletionPort = {
    list: () => [],
    inspect: () => undefined,
    complete: (input) => {
      received = input;
      return Promise.resolve({ admitted: true, workItemId: input.workItemId });
    },
  };
  const expected = {
    workItemId: "wi-recorded",
    judgments: [
      { criterionId: "criterion-1", value: "recorded" as const, resultId: "result:verifier:1" },
    ],
  };

  // When: the Resident selects a verifier-recorded result through the tool boundary.
  await modelToolOutput(completeWorkTool.name, { workItems: port }, RESIDENT)(expected);

  // Then: the id-bearing arm reaches completion unchanged.
  expect(received).toEqual(expected);
});
