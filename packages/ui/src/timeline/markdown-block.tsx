import { UI_NAMES } from "../names";
import { CodeFence, CodeToken } from "../primitives/code";
import { GutterLine } from "../primitives/gutter";
import { Caret } from "../primitives/surface";
import type { TranscriptCodeLine, TranscriptMarkdown } from "./model";
import { Voice } from "./voice";

/**
 * The agent's answer: plain markdown, with no label and no container.
 *
 * There is no `assistant` caption, no avatar, and no fill. The agent's text is
 * simply the column's text — it is the majority of what is on screen and the
 * thing the reader came for, so it takes the default position and everything
 * else is marked relative to it. Labelling the majority case costs a line on
 * every turn to say what the reader already knew.
 *
 * The heading does not get its own size. It is prose at prose's size, set in
 * medium — the transcript has three voices and a fourth for headings is still a
 * fourth. Weight is enough of a step inside a block of body text, and it keeps
 * an answer's structure from competing with the turn boundaries around it.
 */

/**
 * Pre-tokenized code, no highlighter dependency: the caller owns its tokens.
 *
 * That is a boundary decision, not a shortcut. Choosing a grammar and running a
 * lexer is a data concern with a dependency attached; mapping a token's kind
 * onto a tone is the design system's. So the fence takes tokens and spends the
 * achromatic ramp on them.
 *
 * The numbering starts at the block's real `startLine` where the surface
 * declares one, because a fence excerpted from a file and renumbered from 1 has
 * a gutter that actively lies about where the code lives.
 */
function Code({
  lang,
  lines,
  startLine = 1,
}: {
  readonly lang: string;
  readonly lines: readonly TranscriptCodeLine[];
  readonly startLine?: number;
}) {
  return (
    <CodeFence lang={lang}>
      {lines.map((line, lineIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional source lines
        <GutterLine key={lineIndex} mark={line.mark ?? "context"} number={startLine + lineIndex}>
          {line.tokens.map((token, tokenIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional tokens
            <CodeToken key={tokenIndex} tone={token.tone}>
              {token.text}
            </CodeToken>
          ))}
        </GutterLine>
      ))}
    </CodeFence>
  );
}

export function MarkdownBlockView({
  block,
  streamingTail,
}: {
  readonly block: TranscriptMarkdown;
  readonly streamingTail: boolean;
}) {
  // The tail of a streaming block is the one place output is actively arriving,
  // so it is the one caret allowed to blink.
  const caret = streamingTail ? <Caret streaming /> : null;

  if (block.kind === "h2") {
    return (
      <Voice as="h2" className="font-medium" data-ui={UI_NAMES.MarkdownBlock} voice="prose">
        {block.text}
        {caret}
      </Voice>
    );
  }

  if (block.kind === "bullets") {
    return (
      <ul className="flex flex-col gap-1" data-ui={UI_NAMES.MarkdownBlock}>
        {(block.items ?? []).map((item) => (
          <Voice as="li" className="flex gap-2" key={item} voice="prose">
            <span aria-hidden className="text-fg/40">
              ·
            </span>
            <span>{item}</span>
          </Voice>
        ))}
      </ul>
    );
  }

  // The one branch that renders NO `MarkdownBlock`: a fenced block IS a
  // `CodeFence`, and wrapping it in a second named element purely so the name
  // appears would put a layout-free div between the turn's gap and the fence's
  // own border, which is a box the Owner would then be able to address and
  // nobody could style. `Turn.Response › CodeFence` is the complete chain here.
  if (block.kind === "code") {
    return (
      <Code lang={block.lang ?? "text"} lines={block.lines ?? []} startLine={block.startLine} />
    );
  }

  return (
    <Voice as="p" data-ui={UI_NAMES.MarkdownBlock} voice="prose">
      {block.text}
      {caret}
    </Voice>
  );
}
