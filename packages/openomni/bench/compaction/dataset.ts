import type { Message } from "@openomni/protocol";

/**
 * LoCoMo-10 (snap-research/locomo): 10 very-long two-speaker conversations
 * (~19 sessions, 400-700 turns each) with QA pairs annotated with the
 * dialog turns that constitute their evidence. Downloaded on demand and
 * cached next to this file (gitignored) — the dataset is not committed.
 */
const DATASET_URL =
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";
const CACHE_PATH = new URL("./.cache/locomo10.json", import.meta.url).pathname;

interface LocomoTurn {
  readonly speaker: string;
  readonly dia_id: string;
  readonly text: string;
}
export interface LocomoQA {
  readonly question: string;
  readonly answer?: unknown;
  readonly adversarial_answer?: unknown;
  readonly evidence?: readonly string[];
  readonly category: number;
}
export interface LocomoConversation {
  readonly qa: readonly LocomoQA[];
  readonly conversation: Record<string, unknown> & { speaker_a: string; speaker_b: string };
  readonly sample_id: string;
}

export async function loadDataset(): Promise<LocomoConversation[]> {
  const cached = Bun.file(CACHE_PATH);
  if (await cached.exists()) return (await cached.json()) as LocomoConversation[];
  const response = await fetch(DATASET_URL);
  if (!response.ok) throw new Error(`dataset download failed: ${response.status}`);
  const body = await response.text();
  await Bun.write(CACHE_PATH, body);
  return JSON.parse(body) as LocomoConversation[];
}

export interface BuiltConversation {
  readonly sampleId: string;
  readonly messages: Message.WithParts[];
  readonly qa: readonly LocomoQA[];
}

/**
 * speaker_a maps to `user`, speaker_b to `assistant`. LoCoMo is human-human
 * dialogue, so the mapping is a modeling choice: it makes speaker_a's words
 * the ones the pipeline must preserve verbatim, which is exactly the
 * invariant under test.
 */
export function buildConversation(
  conv: LocomoConversation,
  sessionID: string,
  options?: {
    /**
     * Where session timestamps live. "assistant" (default) models the
     * CURRENT production render: timestamps are compressible content and do
     * not survive an anchored cut. "user" is the counterfactual: timestamps
     * ride the verbatim-preserved lane — used to isolate the
     * temporal-grounding gap the 2026-08-19 run found (see bench/README.md).
     */
    readonly headerRole?: "assistant" | "user";
  },
): BuiltConversation {
  const c = conv.conversation;
  const turns: LocomoTurn[] = [];
  for (let index = 1; index < 64; index += 1) {
    const session = c[`session_${index}`];
    if (!Array.isArray(session)) continue;
    // LoCoMo turns speak in relative time ("yesterday", "last year"); the
    // session timestamp is part of the record, exactly like real agent
    // session logs. Injected as an assistant-role header so it is
    // compressible content, not user-sacred text.
    const dateTime = c[`session_${index}_date_time`];
    if (typeof dateTime === "string") {
      turns.push({
        speaker: options?.headerRole === "user" ? c.speaker_a : "__session_header__",
        dia_id: `H${index}`,
        text: `[Session ${index} — ${dateTime}]`,
      });
    }
    turns.push(...(session as LocomoTurn[]));
  }
  const messages: Message.WithParts[] = turns.map((turn, index) => {
    const role = turn.speaker === c.speaker_a ? ("user" as const) : ("assistant" as const);
    const id = `m-${index}`;
    return {
      info:
        role === "user"
          ? {
              id,
              sessionID,
              role,
              time: { created: index },
              agent: "bench",
              model: { providerID: "", modelID: "" },
            }
          : {
              id,
              sessionID,
              role,
              time: { created: index },
              parentID: "",
              modelID: "bench",
              providerID: "bench",
              agent: "bench",
              path: { cwd: "/", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
      parts: [{ id: `${id}-t`, sessionID, messageID: id, type: "text" as const, text: turn.text }],
    };
  });
  return { sampleId: conv.sample_id, messages, qa: conv.qa };
}
