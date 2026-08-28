let sequence = 0;

/** Returns a short, process-unique Unix socket path for an IPC test. */
export function socketPath(label: string): string {
  sequence += 1;
  return `/tmp/omo-ipc-${label.slice(0, 12)}-${process.pid}-${sequence}.sock`;
}
