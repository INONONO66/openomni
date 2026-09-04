interface SessionBinding {
  readonly handle: { close(): Promise<void> };
  release(): void;
}

interface Entry<T extends SessionBinding> {
  readonly binding: T;
  users: number;
  closing?: Promise<void>;
}

export interface SessionBindingLease<T extends SessionBinding> {
  readonly binding: T;
  release(): Promise<void>;
}

/** Retain role-specific session resources only while at least one caller is using them. */
export class SessionBindingCache<T extends SessionBinding> {
  private readonly entries = new Map<string, Entry<T>>();

  async acquire(key: string, create: () => T): Promise<SessionBindingLease<T>> {
    for (;;) {
      const existing = this.entries.get(key);
      if (existing?.closing !== undefined) {
        await existing.closing;
        continue;
      }
      const entry = existing ?? { binding: create(), users: 0 };
      if (existing === undefined) this.entries.set(key, entry);
      entry.users += 1;
      let released = false;
      return {
        binding: entry.binding,
        release: async () => {
          if (released) return;
          released = true;
          await this.release(key, entry);
        },
      };
    }
  }

  private async release(key: string, entry: Entry<T>): Promise<void> {
    entry.users -= 1;
    if (entry.users > 0 || this.entries.get(key) !== entry) return;
    const closing = (async () => {
      try {
        await entry.binding.handle.close();
      } finally {
        try {
          entry.binding.release();
        } finally {
          if (this.entries.get(key) === entry) this.entries.delete(key);
        }
      }
    })();
    entry.closing = closing;
    await closing;
  }
}
