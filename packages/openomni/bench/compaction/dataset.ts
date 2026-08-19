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
  /** Epoch ms of the turn's session date, when the session header parses. */
  readonly epochMs?: number;
}

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

/**
 * LoCoMo session headers look like "1:56 pm on 8 May, 2023". Parsed by hand:
 * engine `Date.parse` behavior on this shape is not specified. Returns
 * undefined (turn keeps a synthetic time) when the shape does not match.
 */
export function parseSessionDate(raw: string): number | undefined {
  const match = raw.match(
    /(?:(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+)?(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i,
  );
  if (!match) return undefined;
  const [, hh, mm, ampm, day, monthName, year] = match;
  const month = MONTHS[(monthName ?? "").toLowerCase()];
  if (month === undefined) return undefined;
  let hour = hh === undefined ? 12 : Number(hh) % 12;
  if (ampm?.toLowerCase() === "pm") hour += 12;
  return Date.UTC(Number(year), month, Number(day), hour, Number(mm ?? 0));
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
     * Where session HEADER turns live. Since the #737 fix production carries
     * per-message time itself (markers at the cut + dated summarizer input,
     * driven by info.time below), so headers exist mainly for the
     * full-history ceiling. "user" keeps the pre-fix counterfactual
     * (headers riding the verbatim lane) alive for continuity with the
     * 2026-08-19 baseline (see bench/README.md).
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
    // assistant-role header (compressible, not user-sacred); production's
    // own date carriage is the info.time-driven marker path (#737).
    const dateTime = c[`session_${index}_date_time`];
    const epochMs = typeof dateTime === "string" ? parseSessionDate(dateTime) : undefined;
    // Fail fast (#741 review F4): a header the parser refuses would fall
    // back to synthetic time and feed the responder a misleading
    // [recorded 1970-01-01] marker — worse than crashing the bench.
    if (typeof dateTime === "string" && epochMs === undefined) {
      throw new Error(`unparseable session date: ${dateTime}`);
    }
    if (typeof dateTime === "string") {
      turns.push({
        speaker: options?.headerRole === "user" ? c.speaker_a : "__session_header__",
        dia_id: `H${index}`,
        text: `[Session ${index} — ${dateTime}]`,
        ...(epochMs === undefined ? {} : { epochMs }),
      });
    }
    // #737: every turn wears its session's recorded time as `info.time` —
    // the field production messages carry — so the shipped time-carriage
    // path (per-message `[recorded date]` markers + dated summarizer input)
    // is exercised as-is, not simulated.
    for (const turn of session as LocomoTurn[]) {
      turns.push(epochMs === undefined ? turn : { ...turn, epochMs });
    }
  }
  const messages: Message.WithParts[] = turns.map((turn, index) => {
    const role = turn.speaker === c.speaker_a ? ("user" as const) : ("assistant" as const);
    const id = `m-${index}`;
    // The +index keeps message order strictly increasing within a session;
    // markers render dates only, so it is invisible.
    const created = turn.epochMs === undefined ? index : turn.epochMs + index;
    return {
      info:
        role === "user"
          ? {
              id,
              sessionID,
              role,
              time: { created },
              agent: "bench",
              model: { providerID: "", modelID: "" },
            }
          : {
              id,
              sessionID,
              role,
              time: { created },
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
