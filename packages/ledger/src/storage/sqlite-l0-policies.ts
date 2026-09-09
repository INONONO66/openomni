import type { Database } from "bun:sqlite";
import { PolicyRow, type Storage as ProtocolStorage } from "@openomni/protocol";
import { PolicySqlRow, decodePolicy } from "./sqlite-l0-rows";

export function createPolicies(
  db: Database,
  transaction: <T>(operation: () => T) => T,
): ProtocolStorage.PolicyRowSubAdapter {
  return {
    appendGeneration(derive) {
      return transaction(() => {
        const all = this.rows();
        const latest = Math.max(0, ...all.map((row) => row.generation));
        const drafts = derive(all.filter((row) => row.generation === latest));
        if (drafts === undefined) return latest;
        if (drafts.length === 0) throw new Error("policy generation must not be empty");
        const generation = latest + 1;
        for (const draft of drafts) {
          if (!this.append({ ...draft, generation })) {
            throw new Error(`could not append policy row: ${draft.name}`);
          }
        }
        return generation;
      });
    },
    append(input) {
      const row = PolicyRow.Row.parse(input);
      const result = db
        .query(
          `INSERT INTO policy (
             name, kind, phase, match, verdict, encoding_version, priority, generation
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(
          row.name,
          row.kind,
          row.phase,
          JSON.stringify(row.match.value),
          JSON.stringify(row.verdict.value),
          row.match.encodingVersion,
          row.priority,
          row.generation,
        );
      return result.changes === 1;
    },
    rows(generation) {
      const rows = PolicySqlRow.array().parse(
        generation === undefined
          ? db
              .query("SELECT * FROM policy ORDER BY generation, priority DESC, name, kind, phase")
              .all()
          : db
              .query(
                "SELECT * FROM policy WHERE generation = ? ORDER BY priority DESC, name, kind, phase",
              )
              .all(generation),
      );
      return rows.map(decodePolicy);
    },
  };
}
