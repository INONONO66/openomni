import { type KeyboardEvent, useEffect, useRef } from "react";
import { UI_NAMES } from "./names";
import type { PendingApproval } from "./timeline/model";
import { Voice } from "./timeline/voice";

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
        <span className="text-voice-secondary"> · {current.reason}</span>
      </Voice>
      
      {more > 0 &&
        (onNext === undefined ? (
          <Voice className="text-voice-secondary" voice="meta">
            +{more}
          </Voice>
        ) : (
          <button
            className="focus-ring rounded-sm px-1 text-voice-secondary transition-quiet hover:text-voice-meta"
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
        
        <button
          className="focus-ring rounded-sm px-2 py-0.5 text-voice-meta transition-quiet hover:text-fg"
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
        <Voice className="text-voice-ambient" voice="meta">
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

export function composerKey(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey">,
  state: { readonly sendable: boolean; readonly hasDecision: boolean },
): ComposerAction {
  const chord = event.metaKey || event.ctrlKey;

  if (state.hasDecision && chord) {
    if (event.key === "Enter") return "approve";
    if (event.key === "Backspace") return "deny";
  }

  if (event.key !== "Enter" || event.shiftKey) return "newline";

  return state.sendable ? "send" : "ignore";
}

function resizeField(node: HTMLTextAreaElement): void {
  node.style.height = "auto";
  const line = Number.parseFloat(getComputedStyle(node).lineHeight) || 21;
  node.style.height = `${Math.min(node.scrollHeight, line * MAX_LINES)}px`;
}

export function Composer({
  value,
  onValueChange,
  onSubmit,
  onStop,
  sending = false,
  disabled = false,
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
  
  readonly onStop?: (() => void) | undefined;
  /** Locks the field and the send control while a turn is in flight. */
  readonly sending?: boolean;
  
  readonly disabled?: boolean;
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
  const sendable = value.trim().length > 0 && !sending && !disabled;

  useEffect(() => {
    const node = field.current;
    if (node === null) return;
    resizeField(node);
  }, []);

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
            className="max-h-[calc(21px*8)] min-h-[21px] w-full flex-1 resize-none bg-transparent font-sans text-[14px]/[21px] text-fg outline-none selection:bg-accent selection:text-accent-fg placeholder:text-voice-ambient disabled:opacity-50"
            data-composer
            data-ui={UI_NAMES.ComposerInput}
            disabled={sending || disabled}
            onChange={(event) => {
              onValueChange(event.target.value);
              resizeField(event.currentTarget);
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            ref={field}
            rows={1}
            value={value}
          />
          
          {sending && onStop !== undefined ? (
            <button
              aria-label="Stop response"
              className="focus-ring -mb-0.5 shrink-0 rounded-sm p-1 text-voice-meta transition-quiet hover:text-fg"
              data-stop
              data-ui={UI_NAMES.ComposerStop}
              onClick={onStop}
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
                <rect fill="currentColor" height="8" rx="1" width="8" x="4" y="4" />
              </svg>
            </button>
          ) : (
            
            <button
              aria-label="Send"
              className="focus-ring -mb-0.5 shrink-0 rounded-sm p-1 text-voice-ambient transition-quiet hover:text-fg disabled:pointer-events-none disabled:opacity-40"
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
          <Voice className="min-w-0 truncate text-voice-ambient" voice="meta">
            {hint}
          </Voice>
          <Voice className="shrink-0 text-voice-ambient" voice="meta">
            {meta}
          </Voice>
        </div>
      </div>
    </div>
  );
}
