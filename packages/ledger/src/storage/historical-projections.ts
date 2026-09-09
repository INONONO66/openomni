// Frozen scalar projections shared by the guarded archive migrations.
export const historicalWaitFields = [
  ["owner_kind", "ownerRef.kind"],
  ["owner_id", "ownerRef.id"],
  ["origin_message_id", "originMessageId"],
  ["revision", "revision"],
  ["partial", "partial"],
  ["endpoint_id", "correlation.endpointId"],
  ["channel_id", "correlation.channelId"],
  ["reply_to_message_id", "correlation.replyToMessageId"],
  ["thread_id", "correlation.threadId"],
  ["token_hash", "correlation.tokenHash"],
  ["external_conversation_id", "correlation.externalConversationId"],
  ["expires_at", "expiresAt"],
  ["time_created", "createdAt"],
  ["time_updated", "updatedAt"],
] as const;

export function historicalMismatch(
  fields: readonly (readonly [string, string])[],
  wait: boolean,
): string[] {
  const clauses = fields.map(
    ([column, field]) => `${column} IS NOT json_extract(data, '$.${field}')`,
  );
  if (wait)
    clauses.push(
      "follow_up_until IS NOT (json_extract(data, '$.resolvedAt') + json_extract(data, '$.followUpWindow'))",
    );
  return clauses;
}

export function historicalDuplicateRows(table: "wait" | "approval"): string {
  return `SELECT ${table}.id FROM ${table},
    json_tree(CASE WHEN json_valid(data) THEN data ELSE '{}' END) AS tree
    WHERE tree.key IS NOT NULL GROUP BY ${table}.rowid, tree.parent, tree.key HAVING count(*) > 1`;
}
