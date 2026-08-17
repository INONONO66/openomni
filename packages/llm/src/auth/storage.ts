import z from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync, writeFileSync, renameSync } from "node:fs";
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
const authFilePathContext = new AsyncLocalStorage<string>();

const getAuthFilePath = () => {
  const scopedPath = authFilePathContext.getStore();
  if (scopedPath) return scopedPath;
  if (process.env.OPENOMNI_AUTH_FILE) {
    return process.env.OPENOMNI_AUTH_FILE;
  }
  return join(homedir(), ".openomni", "auth.json");
};

const ensureAuthDir = () => {
  const filepath = getAuthFilePath();
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
  renameSync(tmpPath, filepath);
};

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

  export async function withFile<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
    return authFilePathContext.run(filepath, fn);
  }

  export async function get(providerID: string): Promise<Info | undefined> {
    const auth = await all();
    return auth[providerID];
  }

  export async function all(): Promise<Record<string, Info>> {
    const filepath = getAuthFilePath();
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

  export async function set(key: string, info: Info) {
    ensureAuthDir();
    const filepath = getAuthFilePath();
    const data = await all();
    writeAuthFile(filepath, JSON.stringify({ ...data, [key]: info }, null, 2));
  }
}
