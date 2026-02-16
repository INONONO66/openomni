export namespace FileLock {
  const locks = new Map<string, string>();

  export function acquire(filePath: string, agentId: string): boolean {
    const owner = locks.get(filePath);
    if (owner && owner !== agentId) {
      return false;
    }
    locks.set(filePath, agentId);
    return true;
  }

  export function release(filePath: string, agentId: string): boolean {
    const owner = locks.get(filePath);
    if (!owner || owner !== agentId) {
      return false;
    }
    locks.delete(filePath);
    return true;
  }

  export function owner(filePath: string): string | undefined {
    return locks.get(filePath);
  }

  export function clear(): void {
    locks.clear();
  }
}
