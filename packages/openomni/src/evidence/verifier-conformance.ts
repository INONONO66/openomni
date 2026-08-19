import { createCanonicalSchemas } from "./verifier-conformance-canonical.js";

const PublicCanonical = createCanonicalSchemas();

export const JsonValueSchema = PublicCanonical.JsonValueSchema;
export const RedactedIdentifierSchema = PublicCanonical.RedactedIdentifierSchema;
export const Sha256DigestSchema = PublicCanonical.Sha256DigestSchema;

export {
  EnvironmentFingerprintInputSchema,
  EnvironmentFingerprintSchema,
  NondeterminismManifestSchema,
  canonicalJson,
  createEnvironmentFingerprint,
  hashCanonicalJson,
  hashNondeterminismManifest,
  type JsonValue,
} from "./verifier-conformance-canonical.js";
