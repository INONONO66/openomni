/** A fresh path cannot collide with stale sockets after process-id reuse. */
export function socketPath(label: string): string {
  return `/tmp/omo-ipc-${label.slice(0, 12)}-${crypto.randomUUID()}.sock`;
}
