import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { Auth } from "@openomni/llm";
import { resolveDefaultProviderModel } from "../agents/model-resolution";
import { installDaemon } from "./systemd";

export interface OnboardFlags {
  tokenHubUrl?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  port?: number;
  host?: string;
  workspace?: string;
  force: boolean;
  installDaemon: boolean;
}

export interface OnboardIO {
  ask(question: string, defaultValue: string): Promise<string>;
  log(line: string): void;
  warn(line: string): void;
  close(): void;
}

export interface OnboardOptions {
  flags?: Partial<OnboardFlags>;
  /** Defaults to ~/.openomni; injectable so tests never touch the real home. */
  baseDir?: string;
  io?: OnboardIO;
}

export function parseOnboardFlags(argv: string[]): OnboardFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      "token-hub-url": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "api-key": { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      workspace: { type: "string" },
      force: { type: "boolean", default: false },
      "install-daemon": { type: "boolean", default: false },
    },
  });
  return {
    tokenHubUrl: values["token-hub-url"],
    provider: values.provider,
    model: values.model,
    apiKey: values["api-key"],
    port: values.port === undefined ? undefined : parsePort(values.port),
    host: values.host,
    workspace: values.workspace,
    force: values.force,
    installDaemon: values["install-daemon"],
  };
}

export async function runOnboard(options: OnboardOptions = {}): Promise<void> {
  const flags: OnboardFlags = { force: false, installDaemon: false, ...options.flags };
  const baseDir = options.baseDir ?? join(homedir(), ".openomni");
  const io = options.io ?? createTerminalIO();
  try {
    // 0700: the directory holds auth.json (credentials) and config.json
    // (tokens) — never group/world readable.
    mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    const configPath = join(baseDir, "config.json");
    const authPath = join(baseDir, "auth.json");
    const raw = readExistingConfig(configPath);
    const server = section(raw, "server");
    const workspace = section(raw, "workspace");
    if (server.port !== undefined && asPort(server.port) === undefined) {
      throw new Error(
        `invalid server.port in existing config: ${JSON.stringify(server.port)} — fix it before onboarding`,
      );
    }

    const workspaceRoot =
      flags.workspace ??
      asString(workspace.root) ??
      (await io.ask("Workspace root", join(baseDir, "workspace")));
    const port =
      flags.port ?? asPort(server.port) ?? parsePort(await io.ask("Server port", "3000"));
    const host = flags.host ?? asString(server.host) ?? (await io.ask("Server host", "127.0.0.1"));
    const existingWsToken = asString(server.wsToken);
    const wsToken = existingWsToken && !flags.force ? existingWsToken : randomToken();
    const existingAdminToken = asString(server.adminToken);
    const adminToken = existingAdminToken && !flags.force ? existingAdminToken : randomToken();

    const tokenHubUrl =
      flags.tokenHubUrl ?? (await io.ask("Token hub base URL (blank to skip auth setup)", ""));
    let provider: string | undefined;
    if (tokenHubUrl !== "") {
      assertValidUrl(tokenHubUrl);
      const providerId = flags.provider ?? (await io.ask("Provider ID", "anthropic"));
      provider = providerId;
      const apiKey =
        flags.apiKey ??
        process.env.OPENOMNI_API_KEY ??
        (await io.ask("Token hub API key (blank if not required; auth.json only)", ""));
      await Auth.withFile(authPath, () =>
        Auth.set(providerId, {
          type: "proxy",
          baseURL: tokenHubUrl,
          ...(apiKey === "" ? {} : { apiKey }),
        }),
      );
      if (await isReachable(tokenHubUrl)) {
        io.log(`token hub reachable: ${tokenHubUrl}`);
      } else {
        io.warn(`token hub not reachable at ${tokenHubUrl} (continuing; verify the URL later)`);
      }
    }

    const model = await resolveModelChoice({ raw, flags, provider, authPath, io });
    if (model) {
      const existingModel = section(raw, "model");
      raw.model = {
        ...(existingModel.provider === model.provider ? existingModel : {}),
        provider: model.provider,
        id: model.id,
      };
    }
    raw.workspace = { ...workspace, root: workspaceRoot };
    raw.server = { ...server, port, host, wsToken, adminToken };

    assertNoApiKeyLeak(raw, "config.json");
    // 0600 from the first byte (wsToken inside) and atomic so a crash cannot
    // leave a truncated config that loadRaw would silently default away.
    const tmpPath = `${configPath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, configPath);
    mkdirSync(workspaceRoot, { recursive: true });

    io.log("");
    io.log(`config:    ${configPath}`);
    if (tokenHubUrl !== "") io.log(`auth:      ${authPath} (mode 0600)`);
    io.log(`workspace: ${workspaceRoot}`);
    io.log(
      `model:     ${model ? `${model.provider}/${model.id}` : "not configured (server boots without realtime surfaces)"}`,
    );
    io.log(`server:    http://${host}:${port} (ws + admin tokens in config.json)`);

    if (flags.installDaemon) {
      installDaemon(io);
    } else {
      io.log("");
      io.log("start the server with: openomni serve");
    }
  } finally {
    io.close();
  }
}

async function resolveModelChoice(input: {
  raw: Record<string, unknown>;
  flags: OnboardFlags;
  provider: string | undefined;
  authPath: string;
  io: OnboardIO;
}): Promise<{ provider: string; id: string } | undefined> {
  const { raw, flags, io } = input;
  const existing = section(raw, "model");
  if (flags.model) {
    // A user-edited provider in config outranks the "anthropic" default —
    // `--model` alone must not flip the provider.
    const provider = input.provider ?? flags.provider ?? asString(existing.provider) ?? "anthropic";
    return { provider, id: flags.model };
  }
  const existingProvider = asString(existing.provider);
  const existingId = asString(existing.id);
  if (existingProvider && existingId) {
    return { provider: existingProvider, id: existingId };
  }
  const credentials = await Auth.withFile(input.authPath, () => Auth.all());
  const firstProvider = input.provider ?? Object.keys(credentials)[0];
  if (!firstProvider) return undefined;
  const suggested = await Auth.withFile(input.authPath, () => resolveDefaultProviderModel());
  const fallback = suggested?.id ?? "";
  const answer = await io.ask(`Default model for ${firstProvider}`, fallback);
  if (answer === "") return undefined;
  return { provider: firstProvider, id: answer };
}

function createTerminalIO(): OnboardIO {
  if (!process.stdin.isTTY) {
    return {
      ask: (_question, defaultValue) => Promise.resolve(defaultValue),
      log: (line) => console.log(line),
      warn: (line) => console.error(line),
      close: () => undefined,
    };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: async (question, defaultValue) => {
      const suffix = defaultValue === "" ? "" : ` [${defaultValue}]`;
      const answer = (await rl.question(`${question}${suffix}: `)).trim();
      return answer === "" ? defaultValue : answer;
    },
    log: (line) => console.log(line),
    warn: (line) => console.error(line),
    close: () => rl.close(),
  };
}

function readExistingConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    throw new Error(
      `existing config is not valid JSON: ${configPath} — fix or remove it before onboarding`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`existing config is not a JSON object: ${configPath}`);
  }
  return parsed;
}

/**
 * config.json must never carry credentials: API keys live only in auth.json.
 * `wsToken` (and channel bot tokens) are server-owned secrets that belong in
 * config, so only key names used by the auth layer are forbidden.
 */
function assertNoApiKeyLeak(value: unknown, path: string): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "apiKey" || key === "key") {
      throw new Error(`refusing to write credential field "${path}.${key}" into config.json`);
    }
    if (Array.isArray(child)) {
      for (const [index, entry] of child.entries()) {
        assertNoApiKeyLeak(entry, `${path}.${key}[${index}]`);
      }
    } else {
      assertNoApiKeyLeak(child, `${path}.${key}`);
    }
  }
}

async function isReachable(baseURL: string): Promise<boolean> {
  try {
    await fetch(baseURL, { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== value.trim()) {
    throw new Error(`invalid port: ${value}`);
  }
  return port;
}

function assertValidUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid token hub URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`token hub URL must be http(s): ${value}`);
  }
}

function section(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = raw[key];
  return isRecord(value) ? { ...value } : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asPort(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
