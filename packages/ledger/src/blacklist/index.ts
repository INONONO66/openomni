import { Actor } from "@openomni/protocol";
import { Storage } from "../storage/storage";
import { requireSubAdapter, withStoreTimestamps } from "../storage/timestamped-store";

interface BlacklistMatchInput {
  readonly actorId?: string;
  readonly endpointId?: string;
  readonly channel?: string;
  readonly candidates?: readonly string[];
}

function requireAdapter(): NonNullable<Storage.Adapter["blacklist"]> {
  return requireSubAdapter(Storage.get().blacklist, "Storage adapter does not implement blacklist");
}

function isActive(entry: Actor.BlacklistEntry, now: number): boolean {
  return entry.expiresAt === undefined || entry.expiresAt > now;
}

function wildcardMatches(pattern: string, candidate: string): boolean {
  if (pattern === "*") return true;
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === candidate;

  let offset = 0;
  for (const [index, part] of parts.entries()) {
    if (part === "") continue;
    const found = candidate.indexOf(part, offset);
    if (found === -1) return false;
    if (index === 0 && found !== 0) return false;
    offset = found + part.length;
  }

  const last = parts[parts.length - 1];
  return last === "" || candidate.endsWith(last ?? "");
}

function entryMatches(entry: Actor.BlacklistEntry, input: BlacklistMatchInput): boolean {
  const candidates = input.candidates ?? [];
  if (entry.kind === "actor") return entry.value === input.actorId;
  if (entry.kind === "endpoint") return entry.value === input.endpointId;
  if (entry.kind === "channel")
    return entry.value === input.channel || candidates.includes(entry.value);
  return candidates.some((candidate) => wildcardMatches(entry.value, candidate));
}

export namespace BlacklistStore {
  export function put(input: Actor.BlacklistEntry): Actor.BlacklistEntry {
    const store = requireAdapter();
    const entry = Actor.BlacklistEntry.parse(withStoreTimestamps(input, store.get(input.id)));
    store.set(entry);
    return entry;
  }

  export function match(
    input: BlacklistMatchInput,
    now = Date.now(),
  ): Actor.BlacklistEntry | undefined {
    // Fail closed like put(): this feeds an absolute deny gate, so an absent
    // adapter must never read as "not blacklisted".
    return requireAdapter()
      .list()
      .find((entry) => isActive(entry, now) && entryMatches(entry, input));
  }
}
