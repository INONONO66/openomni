import { UI_NAMES } from "../names";
import { Caret } from "../primitives/surface";
import type { TranscriptMarkdown } from "./model";
import { Voice } from "./voice";

/**
 * The agent's answer: plain prose, with no label and no container.
 *
 * There is no `assistant` caption, no avatar, and no fill. The agent's text is
 * simply the column's text — it is the majority of what is on screen and the
 * thing the reader came for, so it takes the default position and everything
 * else is marked relative to it. Labelling the majority case costs a line on
 * every turn to say what the reader already knew.
 *
 * One block kind, one branch (#1312): `TranscriptMarkdown` is a paragraph and
 * nothing else, because the paragraph is the only variant with a production
 * producer. A richer block earns its branch back the day a producer ships
 * with it.
 */
export function MarkdownBlockView({
  block,
  streamingTail,
}: {
  readonly block: TranscriptMarkdown;
  readonly streamingTail: boolean;
}) {
  return (
    <Voice as="p" data-ui={UI_NAMES.MarkdownBlock} voice="prose">
      {block.text}
      {/* The tail of a streaming block is the one place output is actively
          arriving, so it is the one caret allowed to blink. */}
      {streamingTail ? <Caret streaming /> : null}
    </Voice>
  );
}
