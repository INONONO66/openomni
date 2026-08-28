let sequence = 0;

/** Returns a short, process-unique Unix socket path for a machine test. */
export function socketPath(): string {
  sequence += 1;
  return `/tmp/omo-machines-${process.pid}-${sequence}.sock`;
}
