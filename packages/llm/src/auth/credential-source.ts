import { z } from "zod";
import { containsExactSecretForm } from "./boundary-sanitizer";

const NonEmpty = z.string().min(1);
const Secret = z.union([
  NonEmpty,
  z.instanceof(Uint8Array).refine((value) => value.byteLength > 0, "secret must not be empty"),
]);

const Metadata = z
  .object({
    providerId: NonEmpty,
    credentialId: NonEmpty,
    rotationId: NonEmpty,
    account: NonEmpty.optional(),
    sourceKind: z.enum(["default_file", "override_file", "injected_runtime"]),
    sourcePath: NonEmpty.optional(),
    endpointRef: NonEmpty.optional(),
  })
  .strict();

const ApiSource = Metadata.extend({
  auth: z.object({ type: z.literal("api"), key: Secret }).strict(),
}).strict();

const ProxySource = Metadata.extend({
  auth: z
    .object({ type: z.literal("proxy"), baseURL: NonEmpty, apiKey: Secret.optional() })
    .strict(),
}).strict();

const OwnerSource = z.union([ApiSource, ProxySource]).superRefine((source, context) => {
  if (source.sourceKind !== "injected_runtime" && !source.sourcePath) {
    context.addIssue({
      code: "custom",
      path: ["sourcePath"],
      message: "file credential sources require sourcePath",
    });
  }
});

type ParsedOwnerSource = z.infer<typeof OwnerSource>;

export type OwnerCredentialSource = Readonly<
  Omit<ParsedOwnerSource, "auth"> & {
    readonly auth:
      | Readonly<{ type: "api"; key: string | Uint8Array }>
      | Readonly<{ type: "proxy"; baseURL: string; apiKey?: string | Uint8Array }>;
  }
>;

export class CredentialSourceError extends Error {
  readonly code: "MISSING_ROTATION_METADATA" | "MALFORMED_CREDENTIAL_SOURCE";
  readonly issues: readonly z.ZodIssue[];

  constructor(code: CredentialSourceError["code"], issues: readonly z.ZodIssue[]) {
    super(
      code === "MISSING_ROTATION_METADATA"
        ? "credential source requires non-empty rotationId metadata"
        : "malformed Owner credential source",
    );
    this.name = "CredentialSourceError";
    this.code = code;
    this.issues = issues;
  }
}

function malformedIssue(path: (string | number)[] = []): z.ZodIssue {
  return { code: "custom", path, message: "malformed credential source" };
}

function copySecret(secret: string | Uint8Array): string | Uint8Array {
  return typeof secret === "string" ? secret : new Uint8Array(secret);
}
function normalizeProxyURL(baseURL: string, secret: string | Uint8Array | undefined): string {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new CredentialSourceError("MALFORMED_CREDENTIAL_SOURCE", [
      malformedIssue(["auth", "baseURL"]),
    ]);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new CredentialSourceError("MALFORMED_CREDENTIAL_SOURCE", [
      malformedIssue(["auth", "baseURL"]),
    ]);
  }

  if (secret !== undefined) {
    let containsSecret: boolean;
    try {
      containsSecret =
        containsExactSecretForm(baseURL, secret) || containsExactSecretForm(url.href, secret);
    } catch {
      throw new CredentialSourceError("MALFORMED_CREDENTIAL_SOURCE", [
        malformedIssue(["auth", "apiKey"]),
      ]);
    }
    if (containsSecret) {
      throw new CredentialSourceError("MALFORMED_CREDENTIAL_SOURCE", [
        malformedIssue(["auth", "baseURL"]),
      ]);
    }
  }
  return url.href;
}

export namespace CredentialSource {
  /** Parse an Owner-controlled credential source without consulting or mutating credential storage. */
  export function parseOwner(input: unknown): OwnerCredentialSource {
    let parsed: ReturnType<typeof OwnerSource.safeParse>;
    try {
      parsed = OwnerSource.safeParse(input);
    } catch {
      throw new CredentialSourceError("MALFORMED_CREDENTIAL_SOURCE", [malformedIssue()]);
    }
    if (!parsed.success) {
      let rotationId: unknown;
      try {
        rotationId =
          typeof input === "object" && input !== null
            ? Reflect.get(input, "rotationId")
            : undefined;
      } catch {
        rotationId = undefined;
      }
      const missingRotation = typeof rotationId !== "string" || rotationId.length === 0;
      throw new CredentialSourceError(
        missingRotation ? "MISSING_ROTATION_METADATA" : "MALFORMED_CREDENTIAL_SOURCE",
        parsed.error.issues,
      );
    }

    const source = parsed.data;
    const auth =
      source.auth.type === "api"
        ? Object.freeze({ type: "api" as const, key: copySecret(source.auth.key) })
        : (() => {
            const baseURL = normalizeProxyURL(source.auth.baseURL, source.auth.apiKey);
            return Object.freeze({
              type: "proxy" as const,
              baseURL,
              ...(source.auth.apiKey === undefined
                ? {}
                : { apiKey: copySecret(source.auth.apiKey) }),
            });
          })();
    return Object.freeze({
      ...source,
      ...(auth.type === "proxy" ? { endpointRef: `proxy:${auth.baseURL}` } : {}),
      auth,
    });
  }
}
