import { FileStorageAdapter } from "./file-storage";
import { SqliteStorageAdapter } from "./sqlite-storage";

export function migrateToSqlite(input: {
  source: FileStorageAdapter;
  target: SqliteStorageAdapter;
  clear?: boolean;
}): { sessions: number; messages: number; parts: number } {
  const { source, target, clear = false } = input;

  return target.transaction(() => {
    if (clear) {
      target.clear();
    }

    let sessionCount = 0;
    let messageCount = 0;
    let partCount = 0;

    const sessions = source.session.list();
    for (const sessionInfo of sessions) {
      target.session.set(sessionInfo.id, sessionInfo);
      sessionCount++;

      const messages = source.message.list(sessionInfo.id);
      for (const messageInfo of messages) {
        target.message.set(sessionInfo.id, messageInfo);
        messageCount++;

        const parts = source.part.list(messageInfo.id);
        for (const part of parts) {
          target.part.set(messageInfo.id, part);
          partCount++;
        }
      }
    }

    return {
      sessions: sessionCount,
      messages: messageCount,
      parts: partCount,
    };
  });
}
