import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { BusEvent, PlainValue } from "@openomni/protocol";
import { isolated } from "./helpers/isolated";
import { seedPolicy } from "./helpers/seed-policy";
import {
  allowConfigure,
  isolatedRuntime,
  withSessionServices,
  type SessionFixture,
} from "./helpers/session-services";
import { closeSessions, type SessionRunner } from "../src/core/run";
import { session } from "../src/testing/registry";
import { InboundAuthorityViolated, inboundAuthority } from "../src/core/run";

// Unit seam: the perimeter verdicts the turn recognizes (issue #1245 (1)).
test("unknown provenance never acts: evidence authority plus a typed violation fact", () => {
  const unknown = inboundAuthority({ kind: "spoofed", payload: "whatever" });
  expect(unknown.authority).toBe("evidence_only");
  expect(unknown.violation?._tag).toBe("InboundAuthorityViolation");
  expect(unknown.violation?.reason).toBe("unknown_origin");
  expect(unknown.violation?.message).toBe("inbound authority violation: unknown_origin");

  const undeclared = inboundAuthority({ kind: "external", messageId: "m", surface: "ws", externalId: "e", actorId: "" });
  expect(undeclared.authority).toBe("evidence_only");
  expect(undeclared.violation?.reason).toBe("undeclared_treatment");
  expect(undeclared.violation?.message).toBe("inbound authority violation: undeclared_treatment");
});

test("known trusted origins keep acting with no violation", () => {
  const origins: readonly (PlainValue | undefined)[] = [
    undefined,
    { kind: "session", id: "parent" },
    { kind: "message", messageId: "m1", senderSessionId: "parent", sourceActionId: "a1" },
    { kind: "external", messageId: "m", surface: "ws", externalId: "e", actorId: "", inboundTreatment: "full_access" },
  ];
  for (const origin of origins) {
    expect(inboundAuthority(origin)).toEqual({ authority: "act" });
  }
});

// Integration seam: a real turn over mail of unknown provenance runs the
// runner with evidence authority and records the violation observation.
test("a turn over unknown-provenance mail runs as evidence and records the violation fact", () => {
  const published: { name: string; data: Record<string, unknown> }[] = [];
  const authorities: (string | undefined)[] = [];
  const runner: SessionRunner = (input) =>
    Effect.sync(() => {
      authorities.push(input.authority);
      return { kind: "result", text: "done" };
    });
  const runtime: SessionFixture = {
    authorizeConfigure: allowConfigure,
    observations: {
      publish: <T>(event: BusEvent.Descriptor<T>, data: T) => {
        published.push({ name: event.name, data: data as Record<string, unknown> });
      },
    },
    clock: () => 1_000,
    entropy: (() => { let next = 0; return () => `authority-id-${++next}`; })(),
    ...isolatedRuntime(),
  };
  return isolated(Effect.scoped(Effect.gen(function* () {
    seedPolicy();
    yield* Effect.addFinalizer(() => closeSessions(runtime).pipe(Effect.orDie));
    const handle = yield* withSessionServices(
      session({ id: "authority-session", role: "resident", runner }, runtime),
      runtime,
    );

    // Trusted provenance: acts, no violation observation.
    yield* handle.prompt("hello", {
      encodingVersion: 1,
      value: { kind: "session", id: "authority-session" },
    });
    expect(authorities).toEqual(["act"]);
    expect(published.filter((event) => event.name === InboundAuthorityViolated.name)).toEqual([]);

    // Unknown provenance: evidence authority plus the recorded violation fact.
    yield* handle.prompt("who sent this?", {
      encodingVersion: 1,
      value: { kind: "spoofed", payload: "mystery" },
    });
    expect(authorities).toEqual(["act", "evidence_only"]);
    const violations = published.filter((event) => event.name === InboundAuthorityViolated.name);
    expect(violations).toHaveLength(1);
    const fact = violations[0]?.data ?? {};
    expect(fact.reason).toBe("unknown_origin");
    expect(fact.sessionId).toBe("authority-session");
    expect(typeof fact.turnId).toBe("string");
    expect(typeof fact.messageId).toBe("string");
    expect(fact.time).toBe(1_000);
  })));
});
