// A worker that spawns fine but NEVER serves IPC (#audit H1): it reads the
// --socket argument and then simply stays alive without listening. The
// supervisor's connect loop must hit its deadline, warn, and kill this
// process — leaving it running wedges the slot forever.
function readCliArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (!readCliArg("--socket")) {
  console.error("never-listening-worker-fixture: missing --socket");
  process.exit(1);
}

setInterval(() => {
  // Keep the process alive; the supervisor must kill it at the connect deadline.
}, 1_000);
