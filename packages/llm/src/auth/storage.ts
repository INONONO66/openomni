import z from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";

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

export namespace Auth {
  export type Info = z.infer<typeof Info>;

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
    const data = await file.json().catch(() => ({}) as Record<string, unknown>);
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
    const file = Bun.file(filepath);
    const data = await all();
    await Bun.write(file, JSON.stringify({ ...data, [key]: info }, null, 2));
    chmodSync(filepath, 0o600);
  }

  export async function remove(key: string) {
    ensureAuthDir();
    const filepath = getAuthFilePath();
    const file = Bun.file(filepath);
    const data = await all();
    delete data[key];
    await Bun.write(file, JSON.stringify(data, null, 2));
    chmodSync(filepath, 0o600);
  }
}
