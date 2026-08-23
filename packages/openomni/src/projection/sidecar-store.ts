import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Content-addressed sidecar store for prompt text and observation bodies.
 *
 * The #493 flat-event projection references blobs by digest (`prompt_hash`,
 * `observation_hash`); the zero-live replay engine re-reads the exact recorded
 * bytes from this store. A blob is addressed solely by the digest of its
 * content, so identical content is stored once.
 *
 * BOUNDARY — RAW BYTES, NO REDACTION: this layer holds prompts and
 * observations verbatim because exact-byte replay requires the original bytes.
 * Redaction is deliberately NOT this layer's responsibility; a later export
 * increment (I6) redacts on export. Do not assume anything read back here has
 * been sanitized.
 *
 * Reads are integrity-bound: `get` recomputes the digest of the stored bytes
 * and fails loud on any mismatch rather than returning tampered content.
 */

/**
 * A content digest in the repo's canonical form:
 * `sha256:${createHash("sha256").update(bytes).digest("hex")}`.
 */
export type SidecarDigest = string & { readonly __brand: "SidecarDigest" };

/**
 * Thrown when a supplied digest is not a well-formed address —
 * `sha256:` followed by exactly 64 lowercase hex chars. A malformed address is
 * a caller bug (or hostile input), distinct from an absent blob; it is
 * rejected before any path construction or map lookup so an attacker cannot
 * traverse out of the store root via a crafted digest.
 */
export class SidecarDigestError extends Error {
  readonly value: string;
  constructor(value: string) {
    super(`malformed sidecar digest: ${value}`);
    this.name = "SidecarDigestError";
    this.value = value;
  }
}

/** Thrown when a requested digest is not present in the store. */
export class SidecarNotFoundError extends Error {
  readonly digest: SidecarDigest;
  constructor(digest: SidecarDigest) {
    super(`sidecar blob not found: ${digest}`);
    this.name = "SidecarNotFoundError";
    this.digest = digest;
  }
}

/**
 * Thrown when stored bytes do not hash to the digest they are addressed by —
 * i.e. the blob was tampered with or corrupted at rest.
 */
export class SidecarIntegrityError extends Error {
  readonly expected: SidecarDigest;
  readonly actual: SidecarDigest;
  constructor(expected: SidecarDigest, actual: SidecarDigest) {
    super(`sidecar integrity check failed: expected ${expected}, got ${actual}`);
    this.name = "SidecarIntegrityError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** Content-addressed blob store with integrity-bound reads. */
export type SidecarStore = {
  /**
   * Content-addressed write. Writing identical bytes twice is idempotent and
   * returns the same digest without duplication or error.
   */
  put(bytes: Uint8Array | string): SidecarDigest;
  /**
   * Integrity-bound read. Recomputes the digest of the stored bytes and throws
   * `SidecarIntegrityError` on mismatch, `SidecarNotFoundError` if absent.
   */
  get(digest: SidecarDigest): Uint8Array;
  /** UTF-8 decodes the bytes returned by `get`. */
  getText(digest: SidecarDigest): string;
  /** Whether a blob is present for `digest` (does not verify integrity). */
  has(digest: SidecarDigest): boolean;
};

function toBytes(bytes: Uint8Array | string): Uint8Array {
  return typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
}

/**
 * Pure content digest. Same content always yields the same digest — no
 * timestamps, no randomness. Strings are normalized to UTF-8 bytes first.
 */
export function digestOf(bytes: Uint8Array | string): SidecarDigest {
  const hex = createHash("sha256").update(toBytes(bytes)).digest("hex");
  return `sha256:${hex}` as SidecarDigest;
}

/** Canonical address shape: `sha256:` + exactly 64 lowercase hex chars. */
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/**
 * Assert `digest` is a well-formed address before it is used to build a
 * filesystem path or look up a blob. Rejects externally-supplied garbage (e.g.
 * a path-traversal payload cast to `SidecarDigest`) fail-loud, so no backend
 * ever touches disk or the map with an untrusted address. Digests produced by
 * `digestOf`/`put` are well-formed by construction and always pass.
 */
function assertWellFormedDigest(digest: SidecarDigest): void {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new SidecarDigestError(digest);
  }
}

/**
 * Strip the `sha256:` prefix, returning the bare hex digest. Callers validate
 * the address first (`assertWellFormedDigest`), so the prefix is always
 * present.
 */
function toHex(digest: SidecarDigest): string {
  return digest.slice("sha256:".length);
}

/** Recompute the digest and fail loud if it does not match the address. */
function verify(digest: SidecarDigest, stored: Uint8Array): Uint8Array {
  const actual = digestOf(stored);
  if (actual !== digest) {
    throw new SidecarIntegrityError(digest, actual);
  }
  return stored;
}

/**
 * Filesystem-backed store. Blobs are laid out git-style as
 * `<rootDir>/<first 2 hex chars>/<rest of hex>` (the `sha256:` prefix is
 * stripped for the path). Directories are created lazily on write. This is the
 * production / archive-adjacent backend.
 */
export function createFilesystemSidecarStore(rootDir: string): SidecarStore {
  function pathFor(digest: SidecarDigest): string {
    // Defense-in-depth: never construct a path from an unvalidated address.
    assertWellFormedDigest(digest);
    const hex = toHex(digest);
    return join(rootDir, hex.slice(0, 2), hex.slice(2));
  }

  /**
   * Atomically publish `content` at `path`: write to a same-directory temp
   * file, fsync it, rename over the target (atomic on POSIX), then fsync the
   * directory so the rename itself is durable. Readers never observe a
   * partial blob and a crash never leaves a torn file at the address.
   */
  function publish(path: string, content: Uint8Array): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
    try {
      writeFileSync(tmp, content);
      const fd = openSync(tmp, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  return {
    put(bytes: Uint8Array | string): SidecarDigest {
      const content = toBytes(bytes);
      const digest = digestOf(content);
      const path = pathFor(digest);
      // Content-addressed: identical content maps to the same path. An
      // existing file is only trusted after verifying it actually hashes to
      // the address — a torn or tampered blob is repaired by republishing.
      if (existsSync(path)) {
        try {
          verify(digest, new Uint8Array(readFileSync(path)));
          return digest;
        } catch {
          // Fall through to republish the correct bytes.
        }
      }
      publish(path, content);
      return digest;
    },
    get(digest: SidecarDigest): Uint8Array {
      const path = pathFor(digest);
      if (!existsSync(path)) {
        throw new SidecarNotFoundError(digest);
      }
      return verify(digest, new Uint8Array(readFileSync(path)));
    },
    getText(digest: SidecarDigest): string {
      return new TextDecoder().decode(this.get(digest));
    },
    has(digest: SidecarDigest): boolean {
      return existsSync(pathFor(digest));
    },
  };
}

/**
 * In-memory, Map-backed store for tests and fixtures. Semantics are identical
 * to the filesystem backend: bytes are copied at both boundaries (`put`
 * stores a copy, `get` returns a copy), so caller-side mutation of an input
 * or a returned buffer never corrupts the store, and stored bytes are
 * re-hashed on `get` (defense in depth, same as the filesystem read path).
 */
export function createInMemorySidecarStore(): SidecarStore {
  const blobs = new Map<SidecarDigest, Uint8Array>();

  return {
    put(bytes: Uint8Array | string): SidecarDigest {
      const content = toBytes(bytes);
      const digest = digestOf(content);
      if (!blobs.has(digest)) {
        blobs.set(digest, content.slice());
      }
      return digest;
    },
    get(digest: SidecarDigest): Uint8Array {
      // Reject malformed addresses before touching the map.
      assertWellFormedDigest(digest);
      const stored = blobs.get(digest);
      if (stored === undefined) {
        throw new SidecarNotFoundError(digest);
      }
      return verify(digest, stored).slice();
    },
    getText(digest: SidecarDigest): string {
      return new TextDecoder().decode(this.get(digest));
    },
    has(digest: SidecarDigest): boolean {
      assertWellFormedDigest(digest);
      return blobs.has(digest);
    },
  };
}
