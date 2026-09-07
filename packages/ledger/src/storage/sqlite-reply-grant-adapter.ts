import type { Database } from "bun:sqlite";
import { Gateway, type Storage as ProtocolStorage } from "@openomni/protocol";

class ReplyGrantProjectionError extends Error {
  readonly code = "incoherent_reply_grant";

  constructor(readonly grantId: string) {
    super(`Incoherent reply-grant projection: ${grantId}`);
    this.name = "ReplyGrantProjectionError";
  }
}

export function createSqliteReplyGrantAdapter(db: Database): ProtocolStorage.ReplyGrantSubAdapter {
  return {
    claim(grant, bound) {
      return db
        .transaction(() => {
          db.query("DELETE FROM reply_grant WHERE expires_at < ?").run(bound.at);
          const existing = db
            .query(
              "SELECT 1 FROM reply_grant WHERE rule_id = ? AND target_actor_id = ? AND surface_key = ?",
            )
            .get(grant.ruleId, grant.targetActorId, grant.replyScope.surfaceKey);
          if (existing !== null) return "existing" as const;
          const capacity = db
            .query<{ count: number }, [string, number]>(
              "SELECT COUNT(*) AS count FROM reply_grant WHERE rule_id = ? AND expires_at >= ?",
            )
            .get(grant.ruleId, bound.at);
          if (capacity !== null && capacity.count >= bound.maxLiveInstances)
            return "capacity" as const;
          db.query(
            `INSERT INTO reply_grant (id, data, rule_id, target_actor_id, surface_key, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            grant.id,
            JSON.stringify(grant),
            grant.ruleId,
            grant.targetActorId,
            grant.replyScope.surfaceKey,
            grant.expiresAt,
          );
          return "claimed" as const;
        })
        .immediate();
    },
    listLive(at) {
      return db
        .query<
          {
            id: string;
            data: string;
            rule_id: string;
            target_actor_id: string;
            surface_key: string;
            expires_at: number;
          },
          [number]
        >(
          "SELECT id, data, rule_id, target_actor_id, surface_key, expires_at FROM reply_grant WHERE expires_at >= ?",
        )
        .all(at)
        .map((row) => {
          const grant = Gateway.SenderTargetGrant.parse(JSON.parse(row.data));
          if (
            grant.id !== row.id ||
            grant.ruleId !== row.rule_id ||
            grant.targetActorId !== row.target_actor_id ||
            grant.replyScope?.surfaceKey !== row.surface_key ||
            grant.expiresAt !== row.expires_at
          ) {
            throw new ReplyGrantProjectionError(row.id);
          }
          return grant;
        });
    },
  };
}
