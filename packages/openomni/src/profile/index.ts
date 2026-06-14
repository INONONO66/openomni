import { z } from "zod";
import { Operational, PolicyDecision } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { PolicyRegistration } from "@openomni/agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { MEMORY_GUIDANCE } from "./guidance";

const PROFILES_DIR = ".openomni/profiles";
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

const MiddlewareConfigSchema = z.object({
  agentName: z.string(),
  homeRoot: z.string().optional(),
});
type MiddlewareConfig = z.infer<typeof MiddlewareConfigSchema>;

export namespace Profile {
  export function createMiddleware(config: MiddlewareConfig): PolicyRegistration[] {
    const home = config.homeRoot ?? homedir();
    const agent = sanitizeName(config.agentName);

    return [
      createSoulRegistration(home, agent),
      createUserRegistration(home, agent),
      createMemoryRegistration(home, agent),
    ];
  }
}

function sanitizeName(name: string): string {
  return SAFE_NAME.test(name) ? name : "";
}

function resolveProfilePath(homeRoot: string, agentName: string, file: string): string {
  return join(homeRoot, PROFILES_DIR, agentName, file);
}

async function loadFile(path: string): Promise<string> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return "";
    return await file.text();
  } catch (error) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "profile:loadFile",
      msg: "profile: failed to read file",
      context: { path, error },
    });
    return "";
  }
}

async function loadSoul(homeRoot: string, agentName: string): Promise<string> {
  if (!agentName) return "";
  return loadFile(resolveProfilePath(homeRoot, agentName, "SOUL.md"));
}

async function loadUser(homeRoot: string, agentName: string): Promise<string> {
  const globalPath = join(homeRoot, PROFILES_DIR, "USER.md");
  const agentPath = agentName ? resolveProfilePath(homeRoot, agentName, "USER.md") : "";

  const parts: string[] = [];
  const global = await loadFile(globalPath);
  if (global) parts.push(global);

  if (agentPath) {
    const agent = await loadFile(agentPath);
    if (agent) parts.push(agent);
  }

  return parts.join("\n\n");
}

async function loadMemory(homeRoot: string, agentName: string): Promise<string> {
  if (!agentName) return "";
  return loadFile(resolveProfilePath(homeRoot, agentName, "MEMORY.md"));
}

function renderSoul(content: string): string {
  return `═══ PERSONA IDENTITY ═══\n${content}`;
}

function renderUser(content: string): string {
  return `═══ USER PROFILE ═══\n${content}`;
}

function renderMemory(content: string): string {
  return `═══ DECLARATIVE MEMORY ═══\n${MEMORY_GUIDANCE}\n\n${content}`;
}

function createSoulRegistration(homeRoot: string, agentName: string): PolicyRegistration {
  let snapshot: string | null = null;

  return {
    name: "profile:soul",
    timing: "context.prepare",
    priority: 25,
    failPolicy: "fail-open",
    fn: async () => {
      try {
        if (snapshot === null) snapshot = await loadSoul(homeRoot, agentName);
        if (!snapshot) return PolicyDecision.allow({ policyId: "profile" });
        return PolicyDecision.allow({
          policyId: "profile.soul",
          effects: [{ type: "prompt.inject_message", message: renderSoul(snapshot) }],
        });
      } catch (error) {
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "profile:soul",
          msg: "profile:soul middleware failed",
          context: { error },
        });
        return PolicyDecision.allow({ policyId: "profile" });
      }
    },
  };
}

function createUserRegistration(homeRoot: string, agentName: string): PolicyRegistration {
  let snapshot: string | null = null;

  return {
    name: "profile:user",
    timing: "context.prepare",
    priority: 30,
    failPolicy: "fail-open",
    fn: async () => {
      try {
        if (snapshot === null) snapshot = await loadUser(homeRoot, agentName);
        if (!snapshot) return PolicyDecision.allow({ policyId: "profile" });
        return PolicyDecision.allow({
          policyId: "profile.user",
          effects: [{ type: "prompt.append_context", context: renderUser(snapshot) }],
        });
      } catch (error) {
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "profile:user",
          msg: "profile:user middleware failed",
          context: { error },
        });
        return PolicyDecision.allow({ policyId: "profile" });
      }
    },
  };
}

function createMemoryRegistration(homeRoot: string, agentName: string): PolicyRegistration {
  let snapshot: string | null = null;

  return {
    name: "profile:memory",
    timing: "context.prepare",
    priority: 35,
    failPolicy: "fail-open",
    fn: async () => {
      try {
        if (snapshot === null) snapshot = await loadMemory(homeRoot, agentName);
        if (!snapshot) return PolicyDecision.allow({ policyId: "profile" });
        return PolicyDecision.allow({
          policyId: "profile.memory",
          effects: [{ type: "prompt.append_context", context: renderMemory(snapshot) }],
        });
      } catch (error) {
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "profile:memory",
          msg: "profile:memory middleware failed",
          context: { error },
        });
        return PolicyDecision.allow({ policyId: "profile" });
      }
    },
  };
}
