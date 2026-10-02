import { expect, test } from "bun:test";
import type { PlainValue } from "@openomni/protocol";
import { inboundAuthority } from "../src/session/run";

const external = {
  kind: "external",
  messageId: "m1",
  surface: "ws",
  externalId: "alice",
  actorId: "",
};

test("kernel-minted and fixture origins act", () => {
  expect(inboundAuthority(undefined)).toEqual({ authority: "act" });
  expect(inboundAuthority({ kind: "session", id: "parent" })).toEqual({ authority: "act" });
  expect(
    inboundAuthority({
      kind: "message",
      messageId: "m1",
      senderSessionId: "parent",
      sourceActionId: "a1",
    }),
  ).toEqual({ authority: "act" });
  expect(
    inboundAuthority({
      kind: "child_terminal",
      messageId: "m2",
      sourceActionId: "a2",
      replyTo: "r1",
    }),
  ).toEqual({ authority: "act" });
});

test("external origins act only with a recorded full_access treatment", () => {
  expect(inboundAuthority({ ...external, inboundTreatment: "full_access" })).toEqual({
    authority: "act",
  });
  expect(inboundAuthority({ ...external, inboundTreatment: "evidence_only" })).toEqual({
    authority: "evidence_only",
  });
});

test("external origins without a decodable treatment fail closed with a violation", () => {
  for (const origin of [
    external,
    { ...external, inboundTreatment: "drop" },
    { ...external, inboundTreatment: 1 },
  ]) {
    const decision = inboundAuthority(origin);
    expect(decision.authority).toBe("evidence_only");
    expect(decision.violation?._tag).toBe("InboundAuthorityViolation");
    expect(decision.violation?.reason).toBe("undeclared_treatment");
  }
});

test("an unrecognized origin shape is unknown provenance: evidence plus a violation", () => {
  const origins: readonly PlainValue[] = [{}, { kind: "mystery" }, { kind: "session" }, "garbage"];
  for (const origin of origins) {
    const decision = inboundAuthority(origin);
    expect(decision.authority).toBe("evidence_only");
    expect(decision.violation?.reason).toBe("unknown_origin");
  }
});
