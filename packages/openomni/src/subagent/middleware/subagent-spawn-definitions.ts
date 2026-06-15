import type { Policy } from "@openomni/protocol";

export const DefaultDenylist = {
  name: "subagent:default-denylist",
  timing: "invoke.prepare",
  priority: 0,
  failPolicy: "fail-closed",
} as const satisfies Policy.Definition;

export const SessionExistence = {
  name: "subagent:session-existence",
  timing: "invoke.prepare",
  priority: 0,
  failPolicy: "fail-closed",
} as const satisfies Policy.Definition;

export const ActiveRun = {
  name: "subagent:active-run",
  timing: "invoke.prepare",
  priority: 10,
  failPolicy: "fail-closed",
} as const satisfies Policy.Definition;

export const CancelTimeout = {
  name: "subagent:cancel-timeout",
  timing: "invoke.prepare",
  priority: 20,
  failPolicy: "fail-closed",
} as const satisfies Policy.Definition;

export const WaitTimeout = {
  name: "subagent:wait-timeout",
  timing: "invoke.prepare",
  priority: 30,
  failPolicy: "fail-closed",
} as const satisfies Policy.Definition;
