import { describe, expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { Placement } from "../src/index";

function tool(
  name: string,
  placement?: Tool.Placement,
  requires?: Tool.Spec["requires"],
): Tool.Spec {
  return {
    name,
    inputSchema: { type: "object" },
    ...(placement === undefined ? {} : { placement }),
    ...(requires === undefined ? {} : { requires }),
  };
}

const targets: readonly Placement.ToolTarget[] = [
  { kind: "host", capabilities: ["network.fetch"] },
  { kind: "machine", id: "machine-z", capabilities: ["screen.read", "input.write"] },
  { kind: "machine", id: "machine-a", capabilities: ["screen.read"] },
];

describe("Placement.resolveTools", () => {
  it("owns absent placement as free and accepts empty requirements everywhere", () => {
    expect(
      Placement.resolveTools(
        [
          tool("implicit"),
          tool("free", "free", []),
          tool("host", "host"),
          tool("machine", "machine"),
        ],
        targets,
      ),
    ).toEqual([
      { tool: tool("implicit"), placement: "free", offerable: true },
      { tool: tool("free", "free", []), placement: "free", offerable: true },
      { tool: tool("host", "host"), placement: "host", offerable: true },
      {
        tool: tool("machine", "machine"),
        placement: "machine",
        offerable: true,
        eligibleTargetIds: ["machine-a", "machine-z"],
      },
    ]);
  });

  it("requires one candidate to hold the complete required subset", () => {
    const tools = [
      tool("free-host", "free", ["network.fetch"]),
      tool("free-machine", "free", ["input.write"]),
      tool("host-machine-only", "host", ["screen.read"]),
      tool("machine-complete", "machine", ["screen.read", "input.write"]),
      tool("machine-unpooled", "machine", ["network.fetch", "screen.read"]),
    ] as const;

    expect(Placement.resolveTools(tools, targets)).toEqual([
      { tool: tools[0], placement: "free", offerable: true },
      { tool: tools[1], placement: "free", offerable: true },
      { tool: tools[2], placement: "host", offerable: false },
      {
        tool: tools[3],
        placement: "machine",
        offerable: true,
        eligibleTargetIds: ["machine-z"],
      },
      {
        tool: tools[4],
        placement: "machine",
        offerable: false,
        eligibleTargetIds: [],
      },
    ]);
  });

  it("rejects unknown capabilities for every placement", () => {
    const tools = [
      tool("free", "free", ["unknown.capability"]),
      tool("host", "host", ["unknown.capability"]),
      tool("machine", "machine", ["unknown.capability"]),
    ] as const;

    expect(Placement.resolveTools(tools, targets)).toEqual([
      { tool: tools[0], placement: "free", offerable: false },
      { tool: tools[1], placement: "host", offerable: false },
      {
        tool: tools[2],
        placement: "machine",
        offerable: false,
        eligibleTargetIds: [],
      },
    ]);
  });

  it("preserves catalog order and sorts multiple eligible machine ids", () => {
    const tools = [tool("second", "machine", ["screen.read"]), tool("first", "free")] as const;
    const first = Placement.resolveTools(tools, targets);
    const second = Placement.resolveTools(tools, targets);

    expect(first).toEqual(second);
    expect(first.map((decision) => decision.tool.name)).toEqual(["second", "first"]);
    expect(first[0]).toEqual({
      tool: tools[0],
      placement: "machine",
      offerable: true,
      eligibleTargetIds: ["machine-a", "machine-z"],
    });
  });

  it("refuses an empty target list with an exact programmer error", () => {
    expect(() => Placement.resolveTools([tool("free")], [])).toThrow(
      new TypeError("tool placement requires a non-empty target list"),
    );
  });
});
