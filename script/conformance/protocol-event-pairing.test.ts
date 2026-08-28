import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const protocolSource = join(import.meta.dir, "..", "..", "packages", "protocol", "src");
const terminalSuffixes = ["completed", "failed", "cancelled", "settled"] as const;

const expectedPairs: Readonly<Record<string, readonly string[]>> = {
  "llm.call.started": ["llm.call.completed", "llm.call.failed"],
  "tool.execution.started": ["tool.execution.completed"],
};

async function protocolEventNames(): Promise<Set<string>> {
  const names = new Set<string>();
  const glob = new Bun.Glob("**/*.ts");
  for await (const path of glob.scan({ cwd: protocolSource, onlyFiles: true })) {
    const source = await Bun.file(join(protocolSource, path)).text();
    for (const match of source.matchAll(/BusEvent\.define\(\s*["']([^"']+)["']/g)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

function pairingProblems(names: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const started = [...names].filter((name) => name.endsWith(".started")).sort();
  if (started.join("\n") !== Object.keys(expectedPairs).sort().join("\n")) {
    problems.push(`Started vocabulary drift: ${started.join(", ")}`);
  }

  for (const startedName of started) {
    const stem = startedName.slice(0, -"started".length);
    const terminals = terminalSuffixes
      .map((suffix) => `${stem}${suffix}`)
      .filter((name) => names.has(name))
      .sort();
    const expected = [...(expectedPairs[startedName] ?? [])].sort();
    if (terminals.length === 0 || terminals.join("\n") !== expected.join("\n")) {
      problems.push(`${startedName} terminals: ${terminals.join(", ") || "none"}`);
    }
  }
  return problems;
}

describe("protocol start/terminal event vocabulary", () => {
  test("every Started event has its pinned terminal counterpart set", async () => {
    const names = await protocolEventNames();
    expect(pairingProblems(names)).toEqual([]);

    const missingTerminal = new Set(names);
    missingTerminal.delete("tool.execution.completed");
    expect(pairingProblems(missingTerminal)).toContain("tool.execution.started terminals: none");
  });
});
