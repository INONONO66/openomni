import z from "zod";
import { join, dirname, resolve } from "node:path";
import { mkdirSync, existsSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { NamedError } from "../error";

const ApiAuth = z.object({
  type: z.literal("api"),
  key: z.string(),
});

const ProxyAuth = z.object({
  type: z.literal("proxy"),
  baseURL: z.string(),
  apiKey: z.string().optional(),
});

const Info = z.discriminatedUnion("type", [ApiAuth, ProxyAuth]);
const writeQueues = new Map<string, Promise<void>>();

const getAuthFilePath = () => {
  if (process.env.OPENOMNI_AUTH_FILE) {
    return resolve(process.env.OPENOMNI_AUTH_FILE);
  }
  return join(homedir(), ".openomni", "auth.json");
};

const ensureAuthDir = (filepath: string) => {
  const dir = dirname(filepath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
};

/**
 * 0600 from the first byte, atomically: the old Bun.write + chmod-after-write
 * left a window where the default-mode file was group/world-readable, and a
 * crash mid-write could leave a truncated file. Write a temp file with the
 * final mode, then rename over the target.
 */
const writeAuthFile = (filepath: string, contents: string): void => {
  const tmpPath = `${filepath}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tmpPath, contents, { mode: 0o600 });
  let swapped = false;
  try {
    renameSync(tmpPath, filepath);
    swapped = true;
  } finally {
    // Never leave a plaintext-credential temp file behind on a failed swap.
    if (!swapped) rmSync(tmpPath, { force: true });
  }
};

async function enqueueWrite<T>(filepath: string, write: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(filepath) ?? Promise.resolve();
  const result = previous.then(write);
  const current = result.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(filepath, current);

  try {
    return await result;
  } finally {
    if (writeQueues.get(filepath) === current) writeQueues.delete(filepath);
  }
}

export namespace Auth {
  export type Info = z.infer<typeof Info>;

  /**
   * A malformed auth file must never read as empty: set() writes
   * `{...all(), [key]: info}` back, so a silent `{}` would destroy every
   * stored credential on the next write.
   */
  export const InvalidFileError = NamedError.create(
    "AuthInvalidFileError",
    z.object({
      message: z.string(),
      path: z.string(),
    }),
  );

  export const ResolutionError = NamedError.create(
    "AuthResolutionError",
    z.object({
      message: z.string(),
      provider: z.string(),
      reason: z.enum(["missing_auth", "invalid_auth"]),
    }),
  );

  /** Explicit credentials are usable only for the provider they were bound to. */
  export async function resolve(
    provider: string,
    explicit?: Info,
    boundProvider = provider,
    allowFallback = true,
  ): Promise<Info> {
    const auth = await candidate(provider, explicit, boundProvider, allowFallback);
    if (auth === undefined)
      throw new ResolutionError({
        message: `No authentication found for provider: ${provider}`,
        provider,
        reason: "missing_auth",
      });
    return validated(provider, auth);
  }

  async function candidate(
    provider: string,
    explicit: Info | undefined,
    boundProvider: string,
    allowFallback: boolean,
  ): Promise<Info | undefined> {
    if (boundProvider === provider && explicit !== undefined) return explicit;
    return allowFallback ? Auth.get(provider) : undefined;
  }

  /** Explicit credentials arrive from callers, so their shape is re-checked, not trusted. */
  function validated(provider: string, auth: Info): Info {
    const parsed = Info.safeParse(auth);
    if (parsed.success && isUsable(parsed.data)) return parsed.data;
    throw new ResolutionError({
      message: `Invalid authentication for provider: ${provider}`,
      provider,
      reason: "invalid_auth",
    });
  }

  function isUsable(info: Info): boolean {
    return info.type === "api" ? info.key.length > 0 : URL.canParse(info.baseURL);
  }

  /** A durable, non-secret handle on the credential an attempt used: kind plus a truncated digest. */
  export function reference(info: Info): {
    readonly type: Info["type"];
    readonly fingerprint: string;
  } {
    const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify(info)).digest("hex");
    return { type: info.type, fingerprint: digest.slice(0, 16) };
  }

  export async function get(providerID: string): Promise<Info | undefined> {
    const auth = await all();
    return auth[providerID];
  }

  export async function all(): Promise<Record<string, Info>> {
    return readAuthFile(getAuthFilePath());
  }

  const AuthFile = z.record(z.string(), z.json());

  async function readAuthFile(filepath: string): Promise<Record<string, Info>> {
    const file = Bun.file(filepath);
    if (!(await file.exists())) return {};
    const document = AuthFile.safeParse(await file.json().catch(invalidJson(filepath)));
    if (!document.success) {
      throw new InvalidFileError({
        message: `auth file is not a JSON object: ${filepath}`,
        path: filepath,
      });
    }
    return credentials(document.data);
  }

  function invalidJson(filepath: string) {
    return <C>(cause: C): never => {
      throw new InvalidFileError(
        { message: `auth file is not valid JSON: ${filepath}`, path: filepath },
        { cause },
      );
    };
  }

  /** Entries that are not credentials are skipped, never rewritten. */
  function credentials(document: z.infer<typeof AuthFile>): Record<string, Info> {
    return Object.fromEntries(
      Object.entries(document).flatMap(([key, value]) => {
        const parsed = Info.safeParse(value);
        return parsed.success ? [[key, parsed.data] as const] : [];
      }),
    );
  }

  export async function set(key: string, info: Info): Promise<void> {
    const filepath = getAuthFilePath();
    await enqueueWrite(filepath, async () => {
      ensureAuthDir(filepath);
      const data = await readAuthFile(filepath);
      writeAuthFile(filepath, JSON.stringify({ ...data, [key]: info }, null, 2));
    });
  }
}
