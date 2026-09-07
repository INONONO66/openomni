import type { ReactNode } from "react";
import { Composer } from "./composer";
import { ScrollArea } from "./primitives/scroll-area";
import { Panel } from "./primitives/surface";
import { Sidebar } from "./sidebar";
import { type HistoryControls, TabStrip, type WindowPlatform } from "./tab-strip";
import type { PendingApproval, TranscriptNode, TurnCost } from "./timeline/model";
import { Timeline } from "./timeline/timeline";
import { Voice } from "./timeline/voice";

/**
 * The console: the whole product surface, as ONE component.
 *
 * The rule the Owner set is the one enforced here: **the shell IS the ui
 * package, composed** — not a thing the ui package can be used to build.
 *
 * ## The frame
 *
 * A 42px tab strip fixed across the top, and under it the reference sidebar
 * mechanism: an in-flow gap that reserves the width, a fixed container that
 * slides, and the main column filling the rest. The strip's controls zone and
 * the gap read the same `--sidebar-width`, so the tab and the column move as
 * one thing. The main column is a 12px-cornered panel on the chrome tone.
 *
 * ## The two-band main column
 *
 * The main column is a scrolling transcript and a fixed input zone, and both
 * hang on ONE 68ch measure — the title has moved up into the strip's tab. A
 * composer wider than the transcript it answers is two columns pretending to be
 * one.
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
  shell,
  strip,
  sidebar,
  title,
  session,
  emptyLabel,
}: {
  readonly shell: ConsoleShell;
  readonly strip: ConsoleStrip;
  /** The tab's title: what the main column is on. No title, no tab. */
  readonly title?: string | undefined;
  /**
   * The sidebar column's content. A slot rather than a prop-driven tree: what
   * ranks and filters those rows is the app's, and this component must not
   * learn it. Composed from `SidebarNav`, `SidebarSection`
   * (`SectionHeader` + `SectionList`), `TreeRow`, and `SidebarFooter`.
   */
  readonly sidebar: ReactNode;
  /**
   * What the main column shows, or `undefined` when nothing is open. The
   * column is then one sentence — `emptyLabel` — on the measure, and no
   * composer: there is nothing to address a message to.
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
    // The window root is the `Sidebar` root: the whole screen is the sidebar
    // mechanism's wrapper, and it is addressed under that name.
    <Sidebar
      data-density="shell"
      floating={shell.sidebarFloating}
      onFloatingChange={shell.onSidebarFloatingChange}
      onToggle={shell.onToggleSidebar}
      onWidthCommit={shell.onSidebarWidthCommit}
      open={shell.sidebarOpen}
      width={shell.sidebarWidth}
    >
      <TabStrip
        createLabel={strip.createLabel}
        history={strip.history}
        onCreate={strip.onCreate}
        platform={strip.platform}
        title={title}
      />
      <Sidebar.Gap />
      <Sidebar.Container>{sidebar}</Sidebar.Container>
      {/* The panel is inset from the chrome on its right and bottom only: its
          left edge meets the sidebar, where the resize handle straddles it,
          and its top meets the strip. */}
      <Panel
        as="main"
        className="mr-2 mb-2 flex min-w-0 flex-1 flex-col group-data-[sidebar-state=collapsed]/sidebar:ml-2"
        edge="box"
        tone="bg"
      >
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
    </Sidebar>
  );
}

/** The frame's state: the app owns it, persists it, and hands it down. */
export interface ConsoleShell {
  readonly sidebarOpen: boolean;
  /** Collapsed but revealed by hover as an overlay. Transient: never persisted. */
  readonly sidebarFloating: boolean;
  /** Already clamped by `clampSidebarWidth`. */
  readonly sidebarWidth: number;
  /** Open ↔ collapsed; while floating, this pins the overlay open. */
  readonly onToggleSidebar: () => void;
  readonly onSidebarFloatingChange: (floating: boolean) => void;
  readonly onSidebarWidthCommit: (width: number) => void;
}

/** What the tab strip needs beyond the open column's title. */
export interface ConsoleStrip {
  readonly createLabel: string;
  readonly onCreate: () => void;
  readonly platform: WindowPlatform;
  readonly history: HistoryControls;
}

/** Everything the main column needs to show one open session. */
export interface ConsoleSession {
  /** The key transcript expansion state is remembered under. */
  readonly id: string;
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
