import { join } from "node:path";
import { homedir } from "node:os";
import type { Execution } from "@openomni/protocol";
import {
  CredentialSource,
  CredentialSourceError,
  type OwnerCredentialSource as ParsedOwnerCredentialSource,
} from "./credential-source";
import type { SecretHandle, SecretRegistry } from "./secret-registry";

export type OwnerCredentialSource = ParsedOwnerCredentialSource;

export type LoadedOwnerCredential = Readonly<{
  handle: SecretHandle;
  ref: Execution.CredentialSourceRefV1;
}>;

export class OwnerCredentialSourceError extends Error {
  readonly code: "UNAVAILABLE" | "MALFORMED";

  constructor(code: OwnerCredentialSourceError["code"], cause?: unknown) {
    super(
      code === "UNAVAILABLE"
        ? "Owner credential source is unavailable"
        : "Owner credential source is malformed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "OwnerCredentialSourceError";
    this.code = code;
  }
}

export interface OwnerCredentialSourceLoadOptions {
  readonly path?: string;
  readonly registry: SecretRegistry;
}

type ResolvedSource = Readonly<{
  path: string;
  sourceKind: "default_file" | "override_file";
}>;

function resolveSource(path: string | undefined): ResolvedSource {
  if (path !== undefined) {
    if (path.length === 0) throw new OwnerCredentialSourceError("UNAVAILABLE");
    return Object.freeze({ path, sourceKind: "override_file" });
  }

  const environmentPath = process.env.OPENOMNI_AUTH_FILE;
  if (environmentPath !== undefined) {
    if (environmentPath.length === 0) throw new OwnerCredentialSourceError("UNAVAILABLE");
    return Object.freeze({ path: environmentPath, sourceKind: "override_file" });
  }

  return Object.freeze({
    path: join(homedir(), ".openomni", "auth.json"),
    sourceKind: "default_file",
  });
}

function malformed(cause?: unknown): never {
  throw new OwnerCredentialSourceError("MALFORMED", cause);
}

function parseEnvelope(
  input: unknown,
  source: ResolvedSource,
): readonly ParsedOwnerCredentialSource[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) malformed();

  const parsed: ParsedOwnerCredentialSource[] = [];
  for (const [providerId, entry] of Object.entries(input)) {
    let credential: ParsedOwnerCredentialSource;
    try {
      credential = CredentialSource.parseOwner(entry);
    } catch (error) {
      if (error instanceof CredentialSourceError) malformed(error);
      malformed();
    }
    if (
      providerId.length === 0 ||
      credential.providerId !== providerId ||
      credential.sourceKind !== source.sourceKind ||
      credential.sourcePath !== source.path
    ) {
      malformed();
    }
    parsed.push(credential);
  }
  return parsed;
}

async function load(
  options: OwnerCredentialSourceLoadOptions,
): Promise<readonly LoadedOwnerCredential[]> {
  const source = resolveSource(options.path);
  let text: string;
  try {
    text = await Bun.file(source.path).text();
  } catch (error) {
    throw new OwnerCredentialSourceError("UNAVAILABLE", error);
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    throw new OwnerCredentialSourceError("MALFORMED", error);
  }

  const credentials = parseEnvelope(envelope, source);
  return Object.freeze(credentials.map((credential) => options.registry.register(credential)));
}

export const OwnerCredentialSource = Object.freeze({ load });
