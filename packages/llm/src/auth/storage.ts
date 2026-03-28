import z from "zod";
import { join } from "path";
import { mkdirSync, existsSync, chmodSync } from "fs";

const OauthAuth = z.object({
  type: z.literal("oauth"),
  refresh: z.string(),
  access: z.string(),
  expires: z.number(),
  accountId: z.string().optional(),
});

const ApiAuth = z.object({
  type: z.literal("api"),
  key: z.string(),
});

const ProxyAuth = z.object({
  type: z.literal("proxy"),
  baseURL: z.string(),
  apiKey: z.string().optional(),
});

const Info = z.discriminatedUnion("type", [OauthAuth, ApiAuth, ProxyAuth]);
type Info = z.infer<typeof Info>;

const getAuthFilePath = () => {
  if (process.env.OPENOMNI_AUTH_FILE) {
    return process.env.OPENOMNI_AUTH_FILE;
  }
  return join(process.env.HOME!, ".openomni", "auth.json");
};

const ensureAuthDir = () => {
  const filepath = getAuthFilePath();
  const dir = filepath.substring(0, filepath.lastIndexOf("/"));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
};

export namespace Auth {
  export type Info = z.infer<typeof Info>;

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
