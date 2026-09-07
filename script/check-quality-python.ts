import { resolve } from "node:path";
import { parseArgs } from "node:util";

// Warnings are fatal, including Unknown/Any and unused results. No diagnostic
// baseline or file/rule exclusions are accepted by this gate.
export function checkPython(argv = process.argv.slice(2)): number {
  const { values } = parseArgs({
    args: argv,
    options: { file: { type: "string", default: "script/quality-mutation/python-engine.py" } },
    strict: true,
  });
  const checker = process.env.BASEDPYRIGHT ?? "basedpyright";
  const version = Bun.spawnSync([checker, "--version"], { timeout: 30_000 });
  if (version.exitCode !== 0 || version.stdout.toString().split("\n")[0] !== "basedpyright 1.39.10") {
    console.error("basedpyright 1.39.10 is required");
    return 2;
  }
  const result = Bun.spawnSync(
    [checker, "--warnings", "--pythonversion", "3.12", resolve(values.file)],
    { timeout: 60_000 },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.exitCode ?? 2;
}

if (import.meta.main) process.exitCode = checkPython();
