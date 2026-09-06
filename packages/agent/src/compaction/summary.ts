import type { Message } from "@openomni/protocol";
import type { CompactionOptions, AnchoredCutAttempt } from "./contract";
import { latestAnchorBody, isAnchorMessage } from "./candidate";
import { prepareSummarizerInput, estimateContentChars, userTextChars } from "./estimate";

const DEFAULT_SUMMARIZER_DEADLINE_MS = 60_000;

const ANCHOR_HEADER = "[Conversation Summary]\n";

/**
 * Time carriage (#737): the one fixed grammar a marker may wear. The whole
 * design leans on this being a closed shape — the L7 byte guard exempts
 * marker parts from the multiset check BECAUSE a 21-char `[recorded date]`
 * line cannot smuggle paraphrased user speech.
 */
const TIME_MARKER_RE = /^\[recorded \d{4}-\d{2}-\d{2}\]$/;

/**
 * One-line legend riding the anchor render whenever markers were stamped
 * (review #741 F1): the bench's responder is told what markers mean, so
 * production models must be told too — a measurement the product does not
 * ship is a primed-reader artifact. Render-only: never enters `anchorBody`,
 * so merge threading and the record are untouched. The literal
 * "YYYY-MM-DD" does not match the marker grammar, so the legend can never
 * be mistaken for a marker by the guard or by extraction.
 */
const MARKER_LEGEND =
  "(Messages marked [recorded YYYY-MM-DD] carry the date each message was recorded, in UTC.)";

export function withSummarizerDeadline(
  summarize: NonNullable<CompactionOptions["onSummarize"]>,
  deadlineMs = DEFAULT_SUMMARIZER_DEADLINE_MS,
  signal?: AbortSignal,
): NonNullable<CompactionOptions["onSummarize"]> {
  return async (messages, previousAnchor, budget, operationSignal = signal) => {
    const controller = new AbortController();
    const cancellation = Promise.withResolvers<never>();
    const abort = (): void => {
      const error = new Error("compaction summarizer operation aborted");
      error.name = "AbortError";
      controller.abort(error);
      cancellation.reject(error);
    };
    operationSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      const error = new Error(`compaction summarizer exceeded ${deadlineMs}ms deadline`);
      error.name = "SummarizerDeadlineError";
      controller.abort(error);
      cancellation.reject(error);
    }, deadlineMs);
    try {
      if (operationSignal?.aborted === true) abort();
      return await Promise.race([
        summarize(messages, previousAnchor, budget, controller.signal),
        cancellation.promise,
      ]);
    } finally {
      clearTimeout(timer);
      operationSignal?.removeEventListener("abort", abort);
    }
  };
}

/**
 * Structural marker identity, shared with the L7 byte guard: metadata tags
 * AND the closed grammar. A part wearing the tags around free text is NOT a
 * marker — it stays plain user speech and fails the byte check if new.
 */
function isTimeCarriageMarkerPart(part: Message.Part): boolean {
  return (
    part.type === "text" &&
    part.metadata?.timeCarriage === true &&
    part.metadata?.policyInjected === true &&
    TIME_MARKER_RE.test(part.text)
  );
}

/** UTC calendar date by design: deterministic across hosts and resumes. The
 * anchor render's legend states the convention (review #741 F3) — a
 * host-local render would re-date the same record per machine. */
function renderTimeMarker(createdMs: number): string {
  return `[recorded ${new Date(createdMs).toISOString().slice(0, 10)}]`;
}

/** At least one text part that is neither policy-injected nor an anchor
 * render — i.e. the message actually carries user speech worth dating. */
function carriesUserSpeech(message: Message.WithParts): boolean {
  return message.parts.some(
    (part) =>
      part.type === "text" &&
      part.metadata?.policyInjected !== true &&
      part.metadata?.compactionAnchor !== true,
  );
}

/**
 * Temporal grounding for the preserved-verbatim lane (#737): the bench
 * showed temporal QA collapsing to 4.8% of the full-history ceiling because
 * preserved user text says "yesterday" and nothing in the window says when
 * that was. The marker is REGENERATED from `info.time.created` at every cut
 * (any stale marker part is replaced, never accumulated — the #722 stacking
 * class), rides beside the user text as a policy-injected part, and never
 * enters the record: the replacement record carries the structured `time`
 * instead, so resume re-derives markers rather than replaying them.
 */
function stampTimeMarker(message: Message.WithParts): Message.WithParts {
  const marker: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID: message.info.sessionID,
    messageID: message.info.id,
    type: "text",
    text: renderTimeMarker(message.info.time.created),
    metadata: { policyInjected: true, timeCarriage: true },
  };
  return {
    info: message.info,
    parts: [marker, ...message.parts.filter((part) => !isTimeCarriageMarkerPart(part))],
  };
}

function replacementRecord(
  stampedUsers: readonly Message.WithParts[],
  keepSpan: readonly Message.WithParts[],
): Array<{
  role: "user" | "assistant";
  text: string;
  time: number;
  policyInjected?: true;
}> {
  return [...stampedUsers, ...keepSpan].flatMap((message) =>
    message.parts
      .filter(
        (part): part is Message.TextPart => part.type === "text" && !isTimeCarriageMarkerPart(part),
      )
      .map((part) => ({
        role: message.info.role,
        text: part.text,
        time: message.info.time.created,
        ...(part.metadata?.policyInjected === true ? { policyInjected: true as const } : {}),
      })),
  );
}

export async function attemptAnchoredCut(
  cutSpan: Message.WithParts[],
  keepSpan: Message.WithParts[],
  precomputed: string | undefined,
  working: Message.WithParts[],
  firstRemoved: Message.WithParts,
  preserveBudget: number,
  contextWindowTokens: number,
  onSummarize: NonNullable<CompactionOptions["onSummarize"]>,
): Promise<AnchoredCutAttempt> {
  const previousAnchor = latestAnchorBody(cutSpan);
  const summarizerInput = cutSpan.filter(
    (message) => message.info.role !== "user" && !isAnchorMessage(message),
  );
  const { messages: boundedInput, budget } = prepareSummarizerInput(
    summarizerInput,
    contextWindowTokens,
    previousAnchor,
  );
  let anchorText = precomputed ?? previousAnchor;
  let summarizerError: Error | undefined;
  if (precomputed === undefined && boundedInput.length > 0) {
    try {
      const merged = await onSummarize(boundedInput, previousAnchor, budget);
      anchorText = merged.trim().length > 0 ? merged : previousAnchor;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (normalized.name === "AbortError") throw normalized;
      summarizerError = normalized;
      anchorText = previousAnchor;
    }
  }

  const preservedUsers = selectPreservedUsers(cutSpan, preserveBudget);
  if (anchorText === undefined && preservedUsers.length === 0) return { summarizerError };
  const stampedUsers = preservedUsers.map((message) =>
    carriesUserSpeech(message) ? stampTimeMarker(message) : message,
  );
  const keptWindow = replacementRecord(stampedUsers, keepSpan);
  const stampedAny = stampedUsers.some((message) => message.parts.some(isTimeCarriageMarkerPart));
  const anchorMessages =
    anchorText === undefined
      ? []
      : [
          buildAnchorMessage(
            anchorText,
            firstRemoved.info.sessionID,
            firstRemoved.info.agent,
            keptWindow,
            stampedAny,
          ),
        ];
  const compacted = [...anchorMessages, ...stampedUsers, ...keepSpan];
  if (estimateContentChars(compacted) >= estimateContentChars(working)) {
    return { summarizerError };
  }
  return {
    cut: {
      messages: compacted,
      compacted: true,
      removedCount: cutSpan.length - preservedUsers.length,
    },
    summarizerError,
  };
}

/**
 * Newest-first selection under the budget, returned in original order. The
 * newest user message is taken unconditionally: a budget that silently
 * dropped ALL user text would violate the invariant the budget exists to
 * serve.
 */
function selectPreservedUsers(
  span: readonly Message.WithParts[],
  budgetChars: number,
): Message.WithParts[] {
  const users = span.filter((message) => message.info.role === "user" && !isAnchorMessage(message));
  const kept: Message.WithParts[] = [];
  let total = 0;
  for (let index = users.length - 1; index >= 0; index -= 1) {
    const candidate = users[index];
    if (candidate === undefined) continue;
    const size = userTextChars(candidate);
    if (kept.length > 0 && total + size > budgetChars) break;
    kept.unshift(candidate);
    total += size;
  }
  return kept;
}

function buildAnchorMessage(
  anchorBody: string,
  sessionID: string,
  agent: string,
  keptWindow: ReadonlyArray<{ role: "user" | "assistant"; text: string; time: number }>,
  withMarkerLegend: boolean,
): Message.WithParts {
  const id = crypto.randomUUID();
  const now = Date.now();
  const render = `${ANCHOR_HEADER}${anchorBody}${withMarkerLegend ? `\n\n${MARKER_LEGEND}` : ""}`;
  const info: Message.UserMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: now },
    agent,
    model: { providerID: "", modelID: "" },
    system: render,
  };
  const textPart: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text: render,
    metadata: {
      compactionAnchor: true,
      anchorBody,
      // Ordered window selection after this anchor — the durable
      // replacement record (#702). Content-borne: hydration flattens to
      // role/content and re-mints ids, so an id record would resolve to
      // nothing (#722 review). Size expectation: one copy of the preserve
      // budget (default 80k chars) plus the protected tail per cut, in an
      // append-only store — linear per record, and the newest-user
      // unconditional rule means one oversized user message can ride into
      // every subsequent record by design (user tokens are irreplaceable).
      keptWindow,
    },
  };
  return { info, parts: [textPart] };
}
