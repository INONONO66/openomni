import type { ReactNode } from "react";
import { MainHeader } from "./chrome";
import { Composer } from "./composer";
import { UI_NAMES } from "./names";
import { ScrollArea } from "./primitives/scroll-area";
import { Panel } from "./primitives/surface";
import type { PendingApproval, TranscriptNode, TurnCost } from "./timeline/model";
import { Timeline } from "./timeline/timeline";
import { Voice } from "./timeline/voice";

/**
 * The console: the whole product surface, as ONE component.
 *
 * The rule the Owner set is the one enforced here: **the shell IS the ui
 * package, composed** — not a thing the ui package can be used to build.
 *
 * ## The three-band main column
 *
 * The main column is a header, a scrolling transcript, and a fixed input zone,
 * and all three hang on ONE 68ch measure. That shared measure is the layout's
 * whole structure: the title sits over the first line of prose, the composer
 * sits under the last, and the reader's eye returns to a single left edge for
 * the entire session. A composer wider than the transcript it answers is two
 * columns pretending to be one.
 *
 * Only the transcript scrolls. The composer is pinned because the place the
 * Owner types must not be something they have to scroll to find, and the
 * approval tray docks inside it for the same reason — a decision that scrolls
 * away is a decision the Owner loses track of while the agent keeps writing.
 *
 * ## What this refuses to own
 *
 * The navigator's CONTENT. The tree renders the attention engine's ranking and
 * the search engine's results — two engines whose every type names a session or
 * a project, which belongs squarely to the app. Pulling the tree in
 * here would drag both engines across the boundary with it, and a design system
 * that ranks sessions by unread count is not a design system.
 *
 * So the navigator arrives as a `sidebar` slot, and every composer callback is
 * likewise the surface's. This component knows that a message can be sent; it
 * does not know what sending one does.
 */
export function Console({
  sidebar,
  session,
  emptyLabel,
}: {
  /**
   * The session navigator. A slot rather than a prop-driven tree: what ranks
   * and filters those rows is the app's, and this component must not learn it.
   */
  readonly sidebar: ReactNode;
  /**
   * What the main column shows, or `undefined` when nothing is open. The
   * column is then a header with no title and one sentence — `emptyLabel` —
   * on the measure, and no composer: there is nothing to address a message to.
   */
  readonly session?: ConsoleSession | undefined;
  /** The main column's sentence when there is nothing to show. */
  readonly emptyLabel?: string | undefined;
}) {
  return (
    // `data-density="shell"` is declared HERE, on the window root, because the
    // whole window IS the shell: the navigator and the transcript are one
    // surface read at one density, and scoping it lower leaves whichever column
    // was missed rendering at the System scale. It re-points the type scale and
    // the vertical rhythm only; no color token changes, so this is a density
    // declaration and not a second theme.
    // The window root answers to `Console`, not to `Panel`. It is a Panel by
    // construction, but the Owner pointing at the whole screen means the
    // composition — and a name that only ever said `Panel` would leave the
    // screen itself unaddressable.
    <Panel
      className="flex h-full min-h-0"
      data-density="shell"
      data-ui={UI_NAMES.Console}
      tone="bg"
    >
      {sidebar}
      <Panel as="main" className="flex min-w-0 flex-1 flex-col" tone="bg">
        <MainHeader detail={session?.detail} title={session?.title} />
        {/* `pinToEnd`: the transcript opens on the LATEST turn and stays there
            as the agent writes. Without it the column opens on the oldest turn
            and the newest one sits below the fold — which is where a row
            reading `waiting for approval` was hiding, one scroll away from an
            Owner with no reason to think anything was waiting. The composer is
            pinned so a decision cannot scroll away; this is the same rule for
            the row that decision belongs to. */}
        <ScrollArea
          className="flex-1"
          contentClassName="mx-auto w-full max-w-measure px-section pt-4 pb-section"
          pinToEnd
        >
          {session === undefined ? (
            // The same voice and tone as an empty transcript, so "nothing open"
            // and "nothing said yet" read as one state of one column rather
            // than two designs of it.
            <Voice className="text-fg/40" voice="meta">
              {emptyLabel}
            </Voice>
          ) : (
            <Timeline
              costs={session.costs}
              emptyLabel={emptyLabel}
              nodes={session.nodes}
              sessionId={session.id}
            />
          )}
        </ScrollArea>
        {session !== undefined &&
          session.onDraftChange !== undefined &&
          session.onSubmit !== undefined && (
            <Composer
              disabled={session.composerDisabled}
              hint={session.composerHint}
              meta={session.composerMeta}
              onApprove={session.onApprove}
              onDeny={session.onDeny}
              onNext={session.onNextApproval}
              onStop={session.onStop}
              onSubmit={session.onSubmit}
              onValueChange={session.onDraftChange}
              pending={session.pending}
              sending={session.sending}
              value={session.draft ?? ""}
            />
          )}
      </Panel>
    </Panel>
  );
}

/** Everything the main column needs to show one open session. */
export interface ConsoleSession {
  /** The key transcript expansion state is remembered under. */
  readonly id: string;
  /** The main column's title and its one qualifying fact. */
  readonly title: string;
  readonly detail?: string | undefined;
  readonly nodes: readonly TranscriptNode[];
  readonly costs?: Readonly<Record<number, TurnCost>>;
  readonly draft?: string;
  readonly onDraftChange?: ((value: string) => void) | undefined;
  readonly onSubmit?: (() => void) | undefined;
  /** Interrupt the turn in flight. The composer's primary action while sending. */
  readonly onStop?: (() => void) | undefined;
  readonly sending?: boolean;
  /** No wire behind the field. `composerHint` is where the surface says why. */
  readonly composerDisabled?: boolean;
  readonly composerHint?: string | undefined;
  readonly composerMeta?: string | undefined;
  readonly pending?: readonly PendingApproval[];
  readonly onApprove?: ((toolId: string) => void) | undefined;
  readonly onDeny?: ((toolId: string) => void) | undefined;
  readonly onNextApproval?: (() => void) | undefined;
}
