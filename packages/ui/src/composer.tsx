import { type KeyboardEvent, useEffect, useRef } from "react";
import { UI_NAMES } from "./names";
import type { PendingApproval } from "./timeline/model";
import { Voice } from "./timeline/voice";

/**
 * The input zone: the composer, and the approval tray that docks above it.
 *
 * It sits at the bottom of the SAME 68ch column the transcript uses, separated
 * from it by a hairline and nothing else. No panel, no fill, no card. The
 * transcript reads as one continuous document down to the line the Owner types
 * on, which is the arrangement every terminal agent converges on for the same
 * reason: the place output arrives and the place input goes are one column, and
 * a boxed composer floating under a centered transcript is two.
 *
 * The hairline is the one border allowed here. It is the boundary between "what
 * happened" and "what I am about to do", and that boundary is real — a reader
 * scrolling up must be able to see where the record stops without reading.
 */

/**
 * The pending-decision tray.
 *
 * This is the whole reason approvals left the transcript. An approve/deny pair
 * rendered inline scrolls away: the agent keeps writing, the decision moves up
 * the column, and the Owner is left with a stalled run and no visible control.
 * Docking it to the input zone means the decision is always exactly where the
 * Owner's hands and eyes already are, and it is the same move the reference
 * terminals make — a permission prompt takes over the input line rather than
 * appearing as a widget in the scrollback.
 *
 * `Approve` is the only accent-filled control on the entire screen. That is the
 * accent budget's largest single expenditure and it is deliberate: if exactly
 * one thing on screen is chromatic, it should be the thing that is blocking
 * work.
 */
export function ApprovalTray({
  pending,
  onApprove,
  onDeny,
  onNext,
}: {
  /** Every outstanding decision. The first is the one being offered. */
  readonly pending: readonly PendingApproval[];
  readonly onApprove: (toolId: string) => void;
  readonly onDeny: (toolId: string) => void;
  /** Rotate to the next pending decision. Absent when there is only one. */
  readonly onNext?: (() => void) | undefined;
}) {
  const current = pending[0];
  if (current === undefined) return null;

  const more = pending.length - 1;

  return (
    // A `<section>` with a label rather than a `role="group"` div: the tray IS a
    // labelled region of the surface, so the element can say that on its own
    // instead of a div borrowing the semantics through an ARIA attribute. A
    // `<fieldset>` would be the other candidate and it is wrong here — these are
    // two commands, not a set of inputs collecting a value.
    <section
      aria-label="Pending approval"
      className="flex flex-wrap items-baseline gap-x-cell gap-y-2 pb-3"
      data-approval-tray
      data-ui={UI_NAMES.ApprovalTray}
    >
      {/* One line, in the meta voice, because it is machine truth about a call:
          what wants to run, and why it stopped. A two-line card with a title and
          a description would make a routine decision look like an incident. */}
      <Voice className="min-w-0 flex-1" voice="meta">
        {current.summary}
        <span className="text-fg/55"> · {current.reason}</span>
      </Voice>
      {/* The DEPTH of the queue is reported whether or not the surface wired a
          way to move through it. Gating the count on `onNext` was a real defect:
          a surface that passed no rotation callback showed three blocked calls
          as one, which is the tray under-reporting exactly the situation it
          exists to surface. The count is a fact about the queue; `next` is a
          control, and only the control depends on the callback. */}
      {more > 0 &&
        (onNext === undefined ? (
          <Voice className="text-fg/55" voice="meta">
            +{more}
          </Voice>
        ) : (
          <button
            className="focus-ring rounded-sm px-1 text-fg/55 transition-quiet hover:text-fg/70"
            onClick={onNext}
            type="button"
          >
            <Voice voice="meta">+{more} · next</Voice>
          </button>
        ))}
      <div className="flex shrink-0 items-baseline gap-2">
        <button
          className="focus-ring rounded-sm bg-accent px-2 py-0.5 text-accent-fg transition-quiet hover:opacity-90"
          data-approve
          data-ui={UI_NAMES.ApprovalTrayApprove}
          onClick={() => onApprove(current.toolId)}
          type="button"
        >
          <Voice voice="meta">Approve</Voice>
        </button>
        {/* Deny is QUIET, and the asymmetry is the point. Two equally weighted
            buttons make the Owner choose between two equal-looking options; one
            filled and one plain says which is the path forward and leaves the
            other one available without arguing for it. */}
        <button
          className="focus-ring rounded-sm px-2 py-0.5 text-fg/70 transition-quiet hover:text-fg"
          data-deny
          data-ui={UI_NAMES.ApprovalTrayDeny}
          onClick={() => onDeny(current.toolId)}
          type="button"
        >
          <Voice voice="meta">Deny</Voice>
        </button>
        {/* The shortcuts are printed rather than hidden in a tooltip: this is a
            decision the Owner will make hundreds of times, and the second time
            they make it they should not be reaching for the mouse. */}
        <Voice className="text-fg/40" voice="meta">
          ⌘↩ / ⌘⌫
        </Voice>
      </div>
    </section>
  );
}

/** How tall the field may grow before it starts scrolling, in lines. */
const MAX_LINES = 8;

/** What a keystroke in the composer means. */
export type ComposerAction = "send" | "newline" | "approve" | "deny" | "ignore";

/**
 * Decide what a keystroke in the composer does.
 *
 * This is split out of the handler and exported so the keyboard contract can be
 * pinned as a TABLE rather than as a rendering test. The rules interact — ⌘↩
 * only means approve while something is pending, and Enter only sends when the
 * draft is sendable — and a test that had to mount a field and dispatch events
 * to discover that would be pinning React, not the contract.
 *
 * The tray's shortcuts are read HERE rather than on the document, so they can
 * only fire while the composer has focus. A global ⌘↩ would approve a shell
 * command from whatever field the Owner happened to be typing in.
 */
export function composerKey(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey">,
  state: { readonly sendable: boolean; readonly hasDecision: boolean },
): ComposerAction {
  const chord = event.metaKey || event.ctrlKey;

  if (state.hasDecision && chord) {
    if (event.key === "Enter") return "approve";
    if (event.key === "Backspace") return "deny";
  }

  // Shift+Enter is the newline, so a multi-paragraph prompt stays possible in a
  // field whose primary key sends. Everything that is not a bare Enter falls
  // through to the textarea's own behaviour untouched.
  if (event.key !== "Enter" || event.shiftKey) return "newline";

  // A bare Enter on an empty or in-flight draft is SWALLOWED rather than passed
  // through: letting it become a newline would put a blank line into a field the
  // Owner believes they just sent from, and pressing Enter twice on an empty
  // composer would silently build a draft of nothing but newlines.
  return state.sendable ? "send" : "ignore";
}

/**
 * The composer.
 *
 * An auto-growing textarea in the PROSE voice — the same 14/21 the Owner's sent
 * messages are set in, so what is typed looks like what was said. A composer
 * set in a different face or size than the message it becomes is a small lie
 * the reader notices without being able to name.
 *
 * It grows from one line to eight and then scrolls. One line at rest because
 * most turns are one line and a permanently tall box is permanently wasted
 * column; eight as the ceiling because past that the field is competing with
 * the transcript for the window, and a long prompt is being composed, not read.
 *
 * Enter sends and Shift+Enter breaks the line. That pairing is the convention
 * every chat surface has settled on, and the cost of getting it backwards is
 * that the Owner's most common action requires a modifier.
 *
 * This component is DATA-BLIND. It does not know what a session is, what a
 * model is, or what happens when it sends — it takes strings and calls back.
 */
export function Composer({
  value,
  onValueChange,
  onSubmit,
  onStop,
  sending = false,
  hint,
  meta,
  pending = [],
  onApprove,
  onDeny,
  onNext,
  placeholder = "Reply",
}: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** Called on Enter and on the send affordance. Never with an empty value. */
  readonly onSubmit: () => void;
  /**
   * Interrupt the turn in flight. When present, the primary action becomes a
   * Stop while `sending` — see the control below for why it replaces send
   * rather than joining it. Optional, because a surface whose transport cannot
   * be cancelled must not be handed a control that does nothing.
   */
  readonly onStop?: (() => void) | undefined;
  /** Locks the field and the send control while a turn is in flight. */
  readonly sending?: boolean;
  /** Left meta: the model, the session — the surface's words, not ours. */
  readonly hint?: string | undefined;
  /** The line under the field: tokens, turn state. The surface's words. */
  readonly meta?: string | undefined;
  readonly pending?: readonly PendingApproval[];
  readonly onApprove?: ((toolId: string) => void) | undefined;
  readonly onDeny?: ((toolId: string) => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly placeholder?: string;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const sendable = value.trim().length > 0 && !sending;

  // Auto-grow by MEASURING, not by counting newlines: a wrapped long line takes
  // two rows on screen and one in the string, and a field sized from the string
  // would clip exactly the prompts that are long enough to need the room.
  //
  // Height is reset to `auto` first so the measurement shrinks as well as
  // grows; reading `scrollHeight` off an already-tall box only ever reports the
  // tall box back.
  useEffect(() => {
    const node = field.current;
    if (node === null) return;
    node.style.height = "auto";
    const line = Number.parseFloat(getComputedStyle(node).lineHeight) || 21;
    node.style.height = `${Math.min(node.scrollHeight, line * MAX_LINES)}px`;
  }, []);

  const grow = (node: HTMLTextAreaElement) => {
    node.style.height = "auto";
    const line = Number.parseFloat(getComputedStyle(node).lineHeight) || 21;
    node.style.height = `${Math.min(node.scrollHeight, line * MAX_LINES)}px`;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerKey(event, { sendable, hasDecision: pending.length > 0 });
    if (action === "newline") return;

    event.preventDefault();
    if (action === "ignore") return;
    if (action === "send") onSubmit();
    if (action === "approve") onApprove?.(pending[0]?.toolId ?? "");
    if (action === "deny") onDeny?.(pending[0]?.toolId ?? "");
  };

  return (
    <div className="mx-auto w-full max-w-measure shrink-0 px-section" data-ui={UI_NAMES.Composer}>
      <div className="border-line border-t pt-3">
        {onApprove !== undefined && onDeny !== undefined && (
          <ApprovalTray onApprove={onApprove} onDeny={onDeny} onNext={onNext} pending={pending} />
        )}
        <div className="flex items-end gap-2">
          <textarea
            aria-label="Message"
            className="max-h-[calc(21px*8)] min-h-[21px] w-full flex-1 resize-none bg-transparent font-sans text-[14px]/[21px] text-fg outline-none selection:bg-accent selection:text-accent-fg placeholder:text-fg/40 disabled:opacity-50"
            data-composer
            data-ui={UI_NAMES.ComposerInput}
            disabled={sending}
            onChange={(event) => {
              onValueChange(event.target.value);
              grow(event.currentTarget);
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            ref={field}
            rows={1}
            value={value}
          />
          {/* ONE primary action, and which one depends on whether a turn is in
              flight. While the agent is writing, send is dead — the field is
              locked and there is nothing to submit — so the slot is the only
              place a stop can go without adding a second control beside a
              disabled one. It is also where the Owner's hand already is, which
              is the whole reason the composer owns the send affordance in the
              first place.

              A surface with no `onStop` keeps the disabled send exactly as
              before: the swap is bound to the SURFACE's ability to interrupt,
              never to a hidden guess about the transport. */}
          {sending && onStop !== undefined ? (
            <button
              aria-label="Stop response"
              className="focus-ring -mb-0.5 shrink-0 rounded-sm p-1 text-fg/70 transition-quiet hover:text-fg"
              data-stop
              data-ui={UI_NAMES.ComposerStop}
              onClick={onStop}
              type="button"
            >
              {/* The same 16-unit grid and the same 16px box as send, so the
                  row does not resize at the moment a turn starts. A filled
                  square rather than an outlined one: this is the one control on
                  the row that is always live, and a hairline square at 10px
                  reads as a checkbox. It takes no accent — the accent budget is
                  spent on Approve, and stopping one's own agent is routine. */}
              {/* biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden; the button carries the name */}
              <svg
                aria-hidden
                className="size-4"
                fill="none"
                height="16"
                viewBox="0 0 16 16"
                width="16"
              >
                <rect fill="currentColor" height="8" rx="1" width="8" x="4" y="4" />
              </svg>
            </button>
          ) : (
            /* Drawn, on a 16-unit grid, for the same reason the chevron is: an
               icon set's stroke does not survive being scaled to this size. It
               is disabled rather than hidden when there is nothing to send, so
               the row's geometry does not change as the Owner types the first
               character. */
            <button
              aria-label="Send"
              className="focus-ring -mb-0.5 shrink-0 rounded-sm p-1 text-fg/40 transition-quiet hover:text-fg disabled:pointer-events-none disabled:opacity-40"
              data-send
              data-ui={UI_NAMES.ComposerSend}
              disabled={!sendable}
              onClick={onSubmit}
              type="button"
            >
              {/* biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden; the button carries the name */}
              <svg
                aria-hidden
                className="size-4"
                fill="none"
                height="16"
                viewBox="0 0 16 16"
                width="16"
              >
                <path
                  d="M8 13V3.5M8 3.5 L4 7.5M8 3.5 L12 7.5"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.5"
                />
              </svg>
            </button>
          )}
        </div>
        {/* One meta line under the field. Left: what is answering. Right: what
            the turn has cost. Both in the meta voice, both dim, because neither
            is something the Owner acts on — they are there to be glanced at. */}
        <div
          className="flex items-baseline justify-between gap-cell pt-2 pb-3"
          data-ui={UI_NAMES.ComposerMeta}
        >
          <Voice className="min-w-0 truncate text-fg/40" voice="meta">
            {hint}
          </Voice>
          <Voice className="shrink-0 text-fg/40" voice="meta">
            {meta}
          </Voice>
        </div>
      </div>
    </div>
  );
}
