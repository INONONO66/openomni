import { FileStorageAdapter } from "./file-storage";
import { SqliteStorageAdapter } from "./sqlite-storage";

export function migrateToSqlite(input: {
  source: FileStorageAdapter;
  target: SqliteStorageAdapter;
}): { sessions: number; messages: number; parts: number } {
  const { source, target } = input;
  let sessionCount = 0;
  let messageCount = 0;
  let partCount = 0;

  // Migrate all sessions
  const sessions = source.session.list();
  for (const sessionInfo of sessions) {
    target.session.set(sessionInfo.id, sessionInfo);
    sessionCount++;

    // Migrate all messages for this session
    const messages = source.message.list(sessionInfo.id);
    for (const messageInfo of messages) {
      target.message.set(sessionInfo.id, messageInfo);
      messageCount++;

      // Migrate all parts for this message
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
}
