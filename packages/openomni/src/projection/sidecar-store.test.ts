import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemSidecarStore,
  createInMemorySidecarStore,
  type SidecarDigest,
  digestOf,
  type SidecarStore,
  SidecarDigestError,
  SidecarIntegrityError,
  SidecarNotFoundError,
} from "./sidecar-store.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sidecar-store-test-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const backends: { name: string; make: () => SidecarStore }[] = [
  { name: "in-memory", make: () => createInMemorySidecarStore() },
  { name: "filesystem", make: () => createFilesystemSidecarStore(mkdtempSync(join(root, "fs-"))) },
];

describe("digestOf", () => {
  it("uses the repo sha256:<hex> convention", () => {
    // sha256 of empty input.
    expect(String(digestOf(new Uint8Array()))).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is deterministic: same content -> same digest", () => {
    expect(digestOf("hello world")).toBe(digestOf("hello world"));
  });

  it("distinguishes different content", () => {
    expect(digestOf("hello")).not.toBe(digestOf("world"));
  });

  it("treats a string and its UTF-8 bytes as equivalent", () => {
    const bytes = new TextEncoder().encode("héllo");
    expect(digestOf("héllo")).toBe(digestOf(bytes));
  });
});

for (const { name, make } of backends) {
  describe(`SidecarStore (${name})`, () => {
    it("roundtrips bytes: put then get returns identical content", () => {
      const store = make();
      const bytes = new TextEncoder().encode("prompt: do the thing");
      const digest = store.put(bytes);
      expect(store.get(digest)).toEqual(bytes);
    });

    it("roundtrips text via getText", () => {
      const store = make();
      const digest = store.put("observation body");
      expect(store.getText(digest)).toBe("observation body");
    });

    it("is idempotent: putting the same bytes twice yields the same digest, no error", () => {
      const store = make();
      const first = store.put("same bytes");
      const second = store.put("same bytes");
      expect(second).toBe(first);
      expect(store.has(first)).toBe(true);
      expect(store.getText(first)).toBe("same bytes");
    });

    it("treats string and its UTF-8 bytes as the same blob", () => {
      const store = make();
      const fromString = store.put("hello");
      const fromBytes = store.put(new TextEncoder().encode("hello"));
      expect(fromBytes).toBe(fromString);
    });

    it("has() is false for absent digests", () => {
      const store = make();
      expect(store.has(digestOf("never stored"))).toBe(false);
    });

    it("get() on an unknown digest throws SidecarNotFoundError carrying the digest", () => {
      const store = make();
      const missing = digestOf("missing");
      let caught: unknown;
      try {
        store.get(missing);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SidecarNotFoundError);
      expect((caught as SidecarNotFoundError).digest).toBe(missing);
    });

    it("getText() on an unknown digest throws SidecarNotFoundError", () => {
      const store = make();
      expect(() => store.getText(digestOf("missing"))).toThrow(SidecarNotFoundError);
    });
  });
}

describe("copy semantics", () => {
  for (const { name, make } of backends) {
    it(`${name}: mutating the input after put does not corrupt the store`, () => {
      const store = make();
      const bytes = new TextEncoder().encode("caller-owned bytes");
      const digest = store.put(bytes);
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      expect(store.getText(digest)).toBe("caller-owned bytes");
    });

    it(`${name}: mutating a returned buffer does not corrupt the store`, () => {
      const store = make();
      const digest = store.put("trusted bytes");
      const returned = store.get(digest);
      returned[0] = (returned[0] ?? 0) ^ 0xff;
      expect(store.getText(digest)).toBe("trusted bytes");
    });
  }
});

describe("integrity enforcement", () => {
  it("filesystem: overwriting the blob file makes get throw SidecarIntegrityError", () => {
    const dir = mkdtempSync(join(root, "fs-tamper-"));
    const store = createFilesystemSidecarStore(dir);
    const digest = store.put("trusted bytes");
    const hex = digest.slice("sha256:".length);
    const path = join(dir, hex.slice(0, 2), hex.slice(2));
    writeFileSync(path, "tampered bytes");
    let caught: unknown;
    try {
      store.get(digest);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SidecarIntegrityError);
    const integrity = caught as SidecarIntegrityError;
    expect(integrity.expected).toBe(digest);
    expect(String(integrity.actual)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(integrity.actual).not.toBe(digest);
  });

  it("filesystem: put over a torn or corrupt existing blob repairs it", () => {
    const dir = mkdtempSync(join(root, "fs-torn-"));
    const store = createFilesystemSidecarStore(dir);
    const digest = digestOf("replay-critical bytes");
    const hex = digest.slice("sha256:".length);
    const path = join(dir, hex.slice(0, 2), hex.slice(2));
    // Simulate a crash mid-write: a partial file already sits at the address.
    mkdirSync(join(dir, hex.slice(0, 2)), { recursive: true });
    writeFileSync(path, "replay-crit");
    expect(store.put("replay-critical bytes")).toBe(digest);
    expect(store.getText(digest)).toBe("replay-critical bytes");
  });
});

describe("malformed digest rejection (path-traversal hardening)", () => {
  const malformed: string[] = [
    "sha256:../../../etc/passwd",
    "sha256:../",
    "not-a-digest",
    // uppercase hex is not canonical.
    `sha256:${"A".repeat(64)}`,
    // 63 hex chars (too short).
    `sha256:${"a".repeat(63)}`,
    // 65 hex chars (too long).
    `sha256:${"a".repeat(65)}`,
    // right shape but missing the sha256: prefix.
    "a".repeat(64),
  ];

  for (const { name, make } of backends) {
    describe(name, () => {
      for (const value of malformed) {
        it(`get() rejects ${JSON.stringify(value)} with SidecarDigestError`, () => {
          const store = make();
          const bad = value as SidecarDigest;
          let caught: unknown;
          try {
            store.get(bad);
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(SidecarDigestError);
          expect((caught as SidecarDigestError).value).toBe(value);
        });

        it(`has() rejects ${JSON.stringify(value)} with SidecarDigestError`, () => {
          const store = make();
          const bad = value as SidecarDigest;
          expect(() => store.has(bad)).toThrow(SidecarDigestError);
        });
      }

      it("rejects malformed digests before any well-formed put, and the happy path still round-trips", () => {
        const store = make();
        const digest = store.put("legit payload");
        expect(store.getText(digest)).toBe("legit payload");
      });
    });
  }

  it("filesystem: a traversal digest never reads outside rootDir", () => {
    const dir = mkdtempSync(join(root, "fs-traversal-"));
    const store = createFilesystemSidecarStore(dir);
    const attack = "sha256:../../../../../../etc/passwd" as SidecarDigest;
    // No filesystem access happens: it throws on the malformed address first.
    expect(() => store.get(attack)).toThrow(SidecarDigestError);
    expect(() => store.has(attack)).toThrow(SidecarDigestError);
  });

  it("digestOf output is always well-formed and passes the guard", () => {
    const store = createInMemorySidecarStore();
    const digest = store.put("well-formed by construction");
    expect(String(digest)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(store.has(digest)).toBe(true);
  });
});

describe("filesystem sharding", () => {
  it("lands a stored digest at <rootDir>/<2>/<rest>", () => {
    const dir = mkdtempSync(join(root, "fs-shard-"));
    const store = createFilesystemSidecarStore(dir);
    const digest = store.put("shard me");
    const hex = digest.slice("sha256:".length);
    const expectedPath = join(dir, hex.slice(0, 2), hex.slice(2));
    expect(Bun.file(expectedPath).size).toBeGreaterThan(0);
  });
});
