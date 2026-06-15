import type { Policy } from "@openomni/protocol";

export const IngressAuthorityDefinitions = {
  CoordinatorPresence: {
    name: "ingress:coordinator-presence",
    timing: "run.start",
    priority: 10,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition,

  SchemaValidation: {
    name: "ingress:schema-validation",
    timing: "run.start",
    priority: 0,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition,

  BlacklistCheck: {
    name: "ingress:blacklist",
    timing: "run.start",
    priority: 5,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition,

  ChannelGrantCheck: {
    name: "ingress:channel-grant",
    timing: "run.start",
    priority: 7,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition,

  AuthorityCheck: {
    name: "ingress:authority",
    timing: "run.start",
    priority: 20,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition,

  ModeDispatch: {
    name: "ingress:mode-dispatch",
    timing: "run.start",
    priority: 35,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition,
} as const;
