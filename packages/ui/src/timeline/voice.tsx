import type { ReactNode } from "react";
import { UI_NAMES } from "../names";

/**
 * The transcript has exactly THREE type voices. This file is all three, and
 * there is no fourth.
 *
 * A transcript is one continuous column of mixed material — a person's
 * sentence, a model's answer, a machine's receipt — and the only thing telling
 * a reader which is which is the type. Every additional size dilutes that
 * signal: at five sizes the reader stops perceiving a system and starts
 * perceiving inconsistency, and the column reads as noisy long before anyone
 * can point at the reason.
 *
 * So the sizes are hard-coded here, as literal `text-[Npx]/[Npx]` pairs, and
 * nowhere else in the transcript. That is deliberate and it is the enforcement
 * mechanism: a test greps the transcript's own markup for font-size classes and
 * finds them only in this file. Routing these through the shared type scale
 * would make them re-pointable by a density scope, and a density scope that
 * silently gives the transcript a fourth size is precisely the drift the three
 * voices exist to prevent.
 *
 *   - **Prose — 14/21 sans.** A person's words and the model's answer. 14px is
 *     the size a paragraph is comfortably read at; 21px leading (1.5) is the
 *     ratio prose wants and the ratio a UI label does not.
 *   - **Code — 13/20 mono.** One step down, because code is quoted material
 *     inside prose, not the prose itself. Mono because the exact characters
 *     matter and alignment carries meaning.
 *   - **Meta — 12/18 mono at 70% foreground.** Tool rows, timings, labels,
 *     counts. Small AND dimmed, so an entire block of receipts recedes as one
 *     texture and the eye can skip it without deciding to.
 *
 * The 70% is an OPACITY on the text color rather than a lighter grey from the
 * ramp, so it holds its relationship to the foreground in both themes with one
 * number instead of two hand-matched ones.
 */

const PROSE = "font-sans text-[14px]/[21px] text-fg";
const CODE = "font-mono text-[13px]/[20px] text-fg";
const META = "font-mono text-[12px]/[18px] text-fg/70";

export type VoiceName = "prose" | "code" | "meta";

const VOICE: Record<VoiceName, string> = { prose: PROSE, code: CODE, meta: META };

/**
 * Text in one of the three voices.
 *
 * `as` exists because a heading in an answer is an `<h2>` semantically while
 * being prose typographically — the transcript does not give headings their own
 * size, it gives them weight. A fourth size for headings is the most tempting
 * one there is and it is still a fourth size.
 */
export function Voice({
  voice,
  as: Tag = "span",
  className = "",
  children,
  ...rest
}: {
  readonly voice: VoiceName;
  readonly as?: "span" | "p" | "div" | "h2" | "li" | "button";
  readonly className?: string;
  readonly children?: ReactNode;
} & Omit<React.ComponentPropsWithoutRef<"span">, "className" | "children">) {
  return (
    // Spread LAST, so a caller that gives its Voice a more specific name wins:
    // the transcript's time line is a `Turn.Meta` that happens to be typeset in
    // the meta voice, and the Owner addresses the line, not the typography.
    <Tag
      className={`${VOICE[voice]} ${className}`}
      data-ui={UI_NAMES.Voice}
      data-voice={voice}
      {...rest}
    >
      {children}
    </Tag>
  );
}
