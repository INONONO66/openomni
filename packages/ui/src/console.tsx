import type { ReactNode } from "react";
import { MainHeader } from "./chrome";
import { Composer } from "./composer";
import { UI_NAMES } from "./names";
import { ScrollArea } from "./primitives/scroll-area";
import { Panel } from "./primitives/surface";
import type { PendingApproval, TranscriptNode, TurnCost } from "./timeline/model";
import { Timeline } from "./timeline/timeline";

/**
 * The console: the whole product surface, as ONE component.
 *
 * This exists because the showcase and the app were drawing the same screen
 * twice, so the showcase could sit green through an entire redesign of the
 * surface it claimed to document. There is one composition now and both
 * consumers render it. The rule the Owner set is the one enforced here: **the
 * shell IS the ui package, composed** — not a thing the ui package can be used
 * to build.
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
 * a project, which BOUNDARY.md puts squarely in the app. Pulling the tree in
 * here would drag both engines across the boundary with it, and a design system
 * that ranks sessions by unread count is not a design system.
 *
 * So the navigator arrives as a `sidebar` slot, and every composer callback is
 * likewise the surface's. This component knows that a message can be sent; it
 * does not know what sending one does.
 */
export function Console({
  sidebar,
  title,
  detail,
  nodes,
  costs,
  sessionId,
  emptyLabel = "No turns in this session yet.",
  draft = "",
  onDraftChange,
  onSubmit,
  sending,
  composerHint,
  composerMeta,
  pending,
  onApprove,
  onDeny,
  onNextApproval,
}: {
  /**
   * The session navigator. A slot rather than a prop-driven tree: what ranks
   * and filters those rows is the app's, and this component must not learn it.
   */
  readonly sidebar: ReactNode;
  /** The main column's title and its one qualifying fact. */
  readonly title: string;
  readonly detail: string;
  readonly nodes: readonly TranscriptNode[];
  readonly costs?: Readonly<Record<number, TurnCost>>;
  /** The key transcript expansion state is remembered under. */
  readonly sessionId: string;
  readonly emptyLabel?: string;
  readonly draft?: string;
  readonly onDraftChange?: ((value: string) => void) | undefined;
  readonly onSubmit?: (() => void) | undefined;
  readonly sending?: boolean;
  readonly composerHint?: string | undefined;
  readonly composerMeta?: string | undefined;
  readonly pending?: readonly PendingApproval[];
  readonly onApprove?: ((toolId: string) => void) | undefined;
  readonly onDeny?: ((toolId: string) => void) | undefined;
  readonly onNextApproval?: (() => void) | undefined;
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
    <Panel className="flex h-full min-h-0" data-density="shell" data-ui={UI_NAMES.Console} tone="bg">
      {sidebar}
      <Panel as="main" className="flex min-w-0 flex-1 flex-col" tone="bg">
        <MainHeader detail={detail} title={title} />
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
          <Timeline costs={costs} emptyLabel={emptyLabel} nodes={nodes} sessionId={sessionId} />
        </ScrollArea>
        {onDraftChange !== undefined && onSubmit !== undefined && (
          <Composer
            hint={composerHint}
            meta={composerMeta}
            onApprove={onApprove}
            onDeny={onDeny}
            onNext={onNextApproval}
            onSubmit={onSubmit}
            onValueChange={onDraftChange}
            pending={pending}
            sending={sending}
            value={draft}
          />
        )}
      </Panel>
    </Panel>
  );
}
