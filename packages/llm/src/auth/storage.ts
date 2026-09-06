import z from "zod";
import { join, dirname, resolve } from "node:path";
import { mkdirSync, existsSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
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
  try {
    renameSync(tmpPath, filepath);
  } catch (error) {
    // Never leave a plaintext-credential temp file behind on a failed swap.
    try {
      unlinkSync(tmpPath);
    } catch {
      /* already gone */
    }
    throw error;
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
    z.object({ message: z.string(), provider: z.string(), reason: z.enum(["missing_auth", "invalid_auth"]) }),
  );

  /** Explicit credentials are usable only for the provider they were bound to. */
  export async function resolve(
    provider: string,
    explicit?: Info,
    boundProvider = provider,
    allowFallback = true,
  ): Promise<Info> {
    const auth = boundProvider === provider && explicit !== undefined
      ? explicit
      : allowFallback ? await Auth.get(provider) : undefined;
    if (auth === undefined) throw new ResolutionError({
      message: `No authentication found for provider: ${provider}`,
      provider, reason: "missing_auth",
    });
    const parsed = Info.safeParse(auth);
    if (!parsed.success || (parsed.data.type === "api" ? parsed.data.key.length === 0 : !URL.canParse(parsed.data.baseURL))) {
      throw new ResolutionError({ message: `Invalid authentication for provider: ${provider}`, provider, reason: "invalid_auth" });
    }
    return parsed.data;
  }

  export async function get(providerID: string): Promise<Info | undefined> {
    const auth = await all();
    return auth[providerID];
  }

  export async function all(): Promise<Record<string, Info>> {
    return readAuthFile(getAuthFilePath());
  }

  async function readAuthFile(filepath: string): Promise<Record<string, Info>> {
    const file = Bun.file(filepath);
    if (!(await file.exists())) return {};

    let data: unknown;
    try {
      data = await file.json();
    } catch (cause) {
      throw new InvalidFileError(
        { message: `auth file is not valid JSON: ${filepath}`, path: filepath },
        { cause },
      );
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new InvalidFileError({
        message: `auth file is not a JSON object: ${filepath}`,
        path: filepath,
      });
    }

    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value);
        if (!parsed.success) return acc;
        acc[key] = parsed.data;
        return acc;
      },
      {} as Record<string, Info>,
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
