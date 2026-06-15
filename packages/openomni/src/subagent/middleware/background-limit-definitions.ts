import type { Policy } from "@openomni/protocol";

export const PerAgent = {
  name: "background:per-agent-limit",
  timing: "invoke.prepare",
  priority: 0,
  failPolicy: "fail-closed",
} as const satisfies Policy.Definition;

export const Depth = {
  name: "background:depth-limit",
  timing: "invoke.prepare",
  priority: 10,
  failPolicy: "fail-closed",
} as const satisfies Policy.Definition;

export const Descendants = {
  name: "background:descendant-limit",
  timing: "invoke.prepare",
  priority: 20,
  failPolicy: "fail-closed",
} as const satisfies Policy.Definition;

export const Total = {
  name: "background:total-limit",
  timing: "invoke.prepare",
  priority: 30,
  failPolicy: "fail-closed",
} as const satisfies Policy.Definition;

export const Queue = {
  name: "background:queue-limit",
  timing: "invoke.prepare",
  priority: 40,
  failPolicy: "fail-closed",
} as const satisfies Policy.Definition;
