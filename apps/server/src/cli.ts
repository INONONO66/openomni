#!/usr/bin/env bun
import { join } from "node:path";
import { main } from "./bootstrap";
import { parseOnboardFlags, runOnboard } from "./cli/onboard";

// Replaced at bundle time via `bun build --define`; stays "dev" for source runs.
const VERSION = process.env.OPENOMNI_CLI_VERSION ?? "dev";

const USAGE = `openomni ${VERSION}

Usage:
  openomni [serve]             Start the OpenOmni server
  openomni onboard [options]   First-run setup wizard (~/.openomni)

Onboard options:
  --token-hub-url <url>   LLM proxy base URL (blank to skip auth setup)
  --provider <id>         Provider ID for the proxy credential (default: anthropic)
  --model <id>            Model ID written to config.json
  --api-key <key>         Proxy API key (stored only in auth.json, mode 0600;
                          prefer the OPENOMNI_API_KEY env var — argv is
                          visible in ps and shell history)
  --port <n>              Server port (default: 3000)
  --host <host>           Server host (default: 127.0.0.1)
  --workspace <dir>       Workspace root (default: ~/.openomni/workspace)
  --force                 Regenerate the WebSocket auth token
  --install-daemon        Install and enable a systemd unit

Flags:
  -v, --version           Print version
  -h, --help              Print this help
`;

function bundledWorkerScript(): string | undefined {
  // The dist bundle cannot resolve the source-tree worker entry; the build
  // emits worker-entry.js next to this file and flags it via --define.
  // import.meta.dir (not URL.pathname) so spaces/non-ASCII paths stay decoded.
  if (!process.env.OPENOMNI_CLI_BUNDLE) return undefined;
  return join(import.meta.dir, "worker-entry.js");
}

async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }
  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (command === undefined || command === "serve") {
    await main({ workerScript: bundledWorkerScript() });
    return;
  }
  if (command === "onboard") {
    await runOnboard({ flags: parseOnboardFlags(rest) });
    return;
  }
  console.error(`unknown command: ${command}\n\n${USAGE}`);
  process.exit(1);
}

run(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
