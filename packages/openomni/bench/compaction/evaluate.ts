import type { LocomoQA } from "./dataset";
import { chat } from "./llm";

/**
 * Two-stage grading, Factory-style probes made answer-grounded:
 *   1. a RESPONDER answers the question reading only the strategy's window;
 *   2. a normalized string match against the gold answer settles the easy
 *      cases; everything else goes to a CROSS-MODEL judge (a different,
 *      stronger model than the responder/summarizer — same-model judging
 *      carries self-preference bias, per the research behind this design)
 *      grading against the gold answer, not against preference.
 */

const RESPONDER_SYSTEM = `You answer questions about a conversation. You are given a possibly-compacted view of that conversation. Answer from the view ONLY, as concisely as possible (a date, a name, a short phrase). Resolve relative time expressions ("yesterday", "last year") to absolute dates using the [Session N — <date>] headers when present. If the view does not contain the answer, reply exactly: UNKNOWN`;

async function respond(
  responderModel: string,
  windowTexts: readonly string[],
  question: string,
): Promise<string> {
  return chat({
    model: responderModel,
    system: RESPONDER_SYSTEM,
    user: `<conversation-view>\n${windowTexts.join("\n---\n")}\n</conversation-view>\n\nQuestion: ${question}`,
    maxTokens: 120,
  });
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,;:!?'"()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cheap settle: gold contained in response (or vice versa) after normalization. */
function normalizedMatch(gold: string, response: string): boolean {
  const g = normalize(gold);
  const r = normalize(response);
  if (g.length === 0 || r.length === 0) return false;
  return r.includes(g) || g.includes(r);
}

const JUDGE_SYSTEM = `You grade answers against a gold reference. Reply with exactly one word: CORRECT if the answer conveys the same fact as the gold reference (paraphrase, formatting, and partial dates count as correct when unambiguous), INCORRECT otherwise. An answer of UNKNOWN is INCORRECT unless the gold reference itself indicates the question is unanswerable.`;

async function judge(
  judgeModel: string,
  question: string,
  gold: string,
  response: string,
): Promise<boolean> {
  const verdict = await chat({
    model: judgeModel,
    system: JUDGE_SYSTEM,
    user: `Question: ${question}\nGold reference: ${gold}\nAnswer to grade: ${response}`,
    maxTokens: 8,
  });
  return verdict.trim().toUpperCase().startsWith("CORRECT");
}

export interface GradedQA {
  readonly qa: LocomoQA;
  readonly response: string;
  readonly correct: boolean;
  readonly settledBy: "match" | "judge";
}

export async function grade(
  models: { responder: string; judge: string },
  windowTexts: readonly string[],
  qa: LocomoQA,
): Promise<GradedQA> {
  const gold = String(qa.answer ?? qa.adversarial_answer ?? "");
  const response = await respond(models.responder, windowTexts, qa.question);
  if (normalizedMatch(gold, response)) {
    return { qa, response, correct: true, settledBy: "match" };
  }
  const correct = await judge(models.judge, qa.question, gold, response);
  return { qa, response, correct, settledBy: "judge" };
}
