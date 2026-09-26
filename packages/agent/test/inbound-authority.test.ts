import { expect, test } from "bun:test";
import { inboundAuthority } from "../src/session-turn";

const external = { kind: "external", messageId: "m1", surface: "ws", externalId: "alice", actorId: "" };

test("internal and fixture origins act", () => {
  expect(inboundAuthority(undefined)).toBe("act");
  expect(inboundAuthority({})).toBe("act");
  expect(inboundAuthority({ kind: "message", messageId: "m1", senderSessionId: "parent", sourceActionId: "a1" })).toBe("act");
});

test("external origins act only with a recorded full_access treatment", () => {
  expect(inboundAuthority({ ...external, inboundTreatment: "full_access" })).toBe("act");
  expect(inboundAuthority({ ...external, inboundTreatment: "evidence_only" })).toBe("evidence_only");
});

test("external origins without a decodable treatment fail closed", () => {
  expect(inboundAuthority(external)).toBe("evidence_only");
  expect(inboundAuthority({ ...external, inboundTreatment: "drop" })).toBe("evidence_only");
  expect(inboundAuthority({ ...external, inboundTreatment: 1 })).toBe("evidence_only");
});
