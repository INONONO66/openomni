import { expect, test } from "bun:test";
import { canonicalDigest } from "@openomni/protocol";
import { approvalRequest } from "./helpers/approval-request";
import { residentSuite } from "./helpers/resident-suite";
import { nextFrame } from "./helpers/ws";

const suite = residentSuite();

test("an authenticated socket still requires the Owner credential on a request answer", async () => {
  const app = await suite.boot({ config: suite.config("answer-auth-", { wsToken: "owner-token" }) });
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "owner-token"]);
  const parsedInput = { operation: { op: "status", args: {} } };
  const request = { ...approvalRequest(parsedInput, {}), inputHash: canonicalDigest(parsedInput) };
  const receipt = nextFrame(socket, (frame) => frame.type === "receipt" && frame.inputId === "auth-check");
  socket.send(JSON.stringify({
    type: "request_answer", inputId: "auth-check", request, decision: "approve", credential: "wrong-owner",
  }));
  expect((await receipt).result).toMatchObject({
    status: "blocked_pre", reasonCode: "request_answer.unauthenticated",
  });
});
