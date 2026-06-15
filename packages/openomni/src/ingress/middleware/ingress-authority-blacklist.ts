export function blacklistReason(kind: string, value: string, reason: string | undefined): string {
  return reason ?? `blacklist.${kind}.${value}`;
}
