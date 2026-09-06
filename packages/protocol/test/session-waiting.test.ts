import { expect, test } from "bun:test";
import { SessionTurn } from "../src";

const terminal = {
  phase: "terminal",
  turnId: "turn",
  text: "",
  boundaryActionId: null,
  resumeCount: 0,
};
test("waiting is a distinct terminal carrying nonempty live alarm identities", () => {
  expect(
    SessionTurn.Terminal.parse({
      ...terminal,
      kind: "waiting",
      reason: "live_wait",
      alarmIds: ["arm"],
    }),
  ).toMatchObject({ kind: "waiting", alarmIds: ["arm"] });
  for (const fields of [
    { kind: "waiting" },
    { kind: "waiting", reason: "live_wait", alarmIds: [] },
    { kind: "result", reason: "live_wait", alarmIds: ["arm"] },
  ])
    expect(SessionTurn.Terminal.safeParse({ ...terminal, ...fields }).success).toBe(false);
  for (const kind of ["result", "error", "interrupted"])
    expect(SessionTurn.Terminal.safeParse({ ...terminal, kind }).success).toBe(true);
});
