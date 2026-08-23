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
      { tool: tool("machine", "machine"), placement: "machine", offerable: true },
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
      { tool: tools[3], placement: "machine", offerable: true },
      { tool: tools[4], placement: "machine", offerable: false },
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
      { tool: tools[2], placement: "machine", offerable: false },
    ]);
  });

  it("preserves catalog order and is deterministic across calls", () => {
    const tools = [tool("second", "machine", ["screen.read"]), tool("first", "free")] as const;
    const first = Placement.resolveTools(tools, targets);

    expect(first).toEqual(Placement.resolveTools(tools, targets));
    expect(first.map((decision) => decision.tool.name)).toEqual(["second", "first"]);
    expect(first[0]).toEqual({ tool: tools[0], placement: "machine", offerable: true });
  });

  it("folds an empty target list to unofferable decisions instead of throwing", () => {
    const tools = [tool("implicit"), tool("host", "host"), tool("machine", "machine")] as const;

    expect(Placement.resolveTools(tools, [])).toEqual([
      { tool: tools[0], placement: "free", offerable: false },
      { tool: tools[1], placement: "host", offerable: false },
      { tool: tools[2], placement: "machine", offerable: false },
    ]);
    expect(Placement.resolveTools([], [])).toEqual([]);
  });

  it("does not let a host target satisfy machine placement, nor the reverse", () => {
    const hostOnly: readonly Placement.ToolTarget[] = [
      { kind: "host", capabilities: ["screen.read"] },
    ];
    const machineOnly: readonly Placement.ToolTarget[] = [
      { kind: "machine", id: "machine-a", capabilities: ["screen.read"] },
    ];
    const machineTool = tool("machine", "machine", ["screen.read"]);
    const hostTool = tool("host", "host", ["screen.read"]);

    expect(Placement.resolveTools([machineTool], hostOnly)).toEqual([
      { tool: machineTool, placement: "machine", offerable: false },
    ]);
    expect(Placement.resolveTools([hostTool], machineOnly)).toEqual([
      { tool: hostTool, placement: "host", offerable: false },
    ]);
  });
});
