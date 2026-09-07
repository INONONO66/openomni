import { expect, test } from "bun:test";
import type { Ingress } from "@openomni/protocol";
import { isAuthorizedTopLevelActor } from "../../src/router/authority-actor";
import { makeInboundEvent } from "./_router-fixture";

test.each([
  "owner",
  "co_owner",
  "manager",
] as const)("canonical %s has top-level standing", (trustTier) => {
  expect(isAuthorizedTopLevelActor(makeInboundEvent({ meta: { actor: { trustTier } } }))).toBe(
    true,
  );
});

test.each([
  "observer",
  "collaborator",
  "assigned_worker",
] as const)("canonical %s cannot acquire authority from privileged legacy role", (trustTier) => {
  expect(
    isAuthorizedTopLevelActor(
      makeInboundEvent({ meta: { actor: { trustTier, role: "resident", trusted: true } } }),
    ),
  ).toBe(false);
});

test.each([
  {},
  { role: "user" },
  { role: "worker" },
  { role: "sub_persona" },
  { role: "manager", trusted: false },
  { role: "manager", trusted: true },
] satisfies Ingress.Actor[])("untiered claims confer no top-level authority: %j", (actor) => {
  expect(isAuthorizedTopLevelActor(makeInboundEvent({ meta: { actor, action: "spawn" } }))).toBe(
    false,
  );
});

test.each([
  "collaborator",
  "observer",
] as const)("%s evidence may reach a resident, never a worker", (trustTier) => {
  const event = makeInboundEvent({
    meta: { actor: { trustTier }, inboundTreatment: "evidence_only" },
  });
  expect(isAuthorizedTopLevelActor(event)).toBe(true);
  expect(isAuthorizedTopLevelActor({ ...event, target: { kind: "worker" } })).toBe(false);
});

test("missing actor fails closed", () => {
  expect(isAuthorizedTopLevelActor(makeInboundEvent())).toBe(false);
});
