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
     * Where session timestamps live. Production renders NO timestamps at
     * all; "assistant" (default) is therefore a BEST-CASE variant of
     * production (compressible content that does not survive an anchored
     * cut), and "user" is the counterfactual where timestamps ride the
     * verbatim-preserved lane — used to isolate the temporal-grounding gap
     * (#737, see bench/README.md).
     */
    readonly headerRole?: "assistant" | "user";
  },
): BuiltConversation {
  const c = conv.conversation;
  const turns: LocomoTurn[] = [];
  for (let index = 1; index < 64; index += 1) {
    const session = c[`session_${index}`];
    if (!Array.isArray(session)) continue;
    // LoCoMo turns speak in relative time ("yesterday", "last year") and
    // need their session timestamp to be answerable at all. Injected as an
    // assistant-role header (compressible, not user-sacred) — a best-case
    // variant of production, which renders no timestamps (#737).
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
