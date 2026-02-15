import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "./profile";
import type { AgentRegistryStore } from "./profile-store";
import { AgentProfileSchema } from "./profile";

export class FileAgentRegistryStore implements AgentRegistryStore {
  private profiles = new Map<string, AgentProfile>();
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.loadFromDisk();
  }

  get(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  set(id: string, profile: AgentProfile): void {
    this.profiles.set(id, profile);
    this.flushProfile(id, profile);
  }

  list(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  remove(id: string): boolean {
    const deleted = this.profiles.delete(id);
    if (deleted) {
      const target = join(this.dir, `${this.encodeFilename(id)}.json`);
      try {
        unlinkSync(target);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return deleted;
  }

  has(id: string): boolean {
    return this.profiles.has(id);
  }

  clear(): void {
    for (const id of this.profiles.keys()) {
      const target = join(this.dir, `${this.encodeFilename(id)}.json`);
      try {
        unlinkSync(target);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    this.profiles.clear();
  }

  size(): number {
    return this.profiles.size;
  }

  private loadFromDisk(): void {
    if (!existsSync(this.dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const filePath = join(this.dir, entry);
      try {
        const raw = JSON.parse(readFileSync(filePath, "utf-8"));
        const profile = AgentProfileSchema.parse(raw);
        this.profiles.set(profile.id, profile);
      } catch {
        continue;
      }
    }
  }

  private flushProfile(id: string, profile: AgentProfile): void {
    this.atomicWrite(
      `${this.encodeFilename(id)}.json`,
      JSON.stringify(profile, null, 2),
    );
  }

  private atomicWrite(filename: string, data: string): void {
    const target = join(this.dir, filename);
    const tmp = target + ".tmp";
    try {
      writeFileSync(tmp, data, "utf-8");
      renameSync(tmp, target);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* noop */
      }
      throw err;
    }
  }

  private encodeFilename(id: string): string {
    return encodeURIComponent(id);
  }
}
