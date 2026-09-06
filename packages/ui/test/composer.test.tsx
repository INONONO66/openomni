import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalTray, Composer, type ComposerAction, composerKey } from "../src";

/**
 * The composer's keyboard contract and the approval tray's shape.
 *
 * The keyboard half is pinned against the pure decision function rather than a
 * mounted field, because the rules INTERACT: ⌘↩ means approve only while
 * something is pending, Enter sends only when the draft is sendable, and every
 * other Enter has to reach the textarea untouched. A test that dispatched events
 * at a real DOM would be pinning React's synthetic event system on the way to
 * checking four booleans.
 */

const key = (
  k: string,
  mods: { shift?: boolean; meta?: boolean } = {},
  state: { sendable?: boolean; hasDecision?: boolean } = {},
): ComposerAction =>
  composerKey(
    { key: k, shiftKey: mods.shift ?? false, metaKey: mods.meta ?? false, ctrlKey: false },
    { sendable: state.sendable ?? true, hasDecision: state.hasDecision ?? false },
  );

describe("the composer keyboard", () => {
  test("Given a draft, When Enter is pressed, Then it sends", () => {
    expect(key("Enter")).toBe("send");
  });

  test("Given a draft, When Shift+Enter is pressed, Then it takes a newline", () => {
    // The escape hatch that makes Enter-to-send survivable. Without it a
    // multi-paragraph prompt cannot be written in this field at all.
    expect(key("Enter", { shift: true })).toBe("newline");
  });

  test("Given an empty or in-flight draft, When Enter is pressed, Then nothing happens", () => {
    // Swallowed, not passed through: a newline here lands in a field the Owner
    // believes they just sent from.
    expect(key("Enter", {}, { sendable: false })).toBe("ignore");
  });

  test("Given any other key, When pressed, Then the field keeps it", () => {
    for (const k of ["a", "Backspace", "ArrowUp", "Tab"]) {
      expect(key(k), k).toBe("newline");
    }
  });

  test("Given a pending decision, When ⌘↩ is pressed, Then it approves", () => {
    expect(key("Enter", { meta: true }, { hasDecision: true })).toBe("approve");
  });

  test("Given a pending decision, When ⌘⌫ is pressed, Then it denies", () => {
    expect(key("Backspace", { meta: true }, { hasDecision: true })).toBe("deny");
  });

  test("Given no pending decision, When ⌘⌫ is pressed, Then the field keeps it", () => {
    // Command+Delete is delete-to-start-of-line in every text field on this
    // platform, so it must reach the textarea untouched when nothing is pending.
    expect(key("Backspace", { meta: true }, { hasDecision: false })).toBe("newline");
  });

  test("Given no pending decision, When Command+Enter is pressed, Then it sends", () => {
    // Command+Enter falls through to send, which is deliberate rather than
    // incidental: it is the submit chord in every chat surface the Owner already
    // uses, and swallowing it here would make this the one field where the
    // familiar key does nothing. The tray's claim on it is CONDITIONAL, and the
    // condition is that something is actually blocked.
    expect(key("Enter", { meta: true }, { hasDecision: false })).toBe("send");
  });

  test("Given a decision and a sendable draft, When ⌘↩ is pressed, Then approve wins", () => {
    // The blocked call outranks the draft: the agent is stopped and the message
    // is not.
    expect(key("Enter", { meta: true }, { hasDecision: true, sendable: true })).toBe("approve");
  });
});

const composer = (props: Partial<Parameters<typeof Composer>[0]> = {}) =>
  renderToStaticMarkup(
    <Composer
      onValueChange={() => undefined}
      onSubmit={() => undefined}
      pending={[]}
      value=""
      {...props}
    />,
  );

describe("the composer surface", () => {
  test("Given the composer, When rendered, Then it is a hairline and a field", () => {
    // No card, no rounded well, no drop shadow. The composer is where the
    // column ends, and a border-top says that with one pixel.
    const html = composer();

    expect(html).toContain("border-t");
    expect(html).toContain("<textarea");
    expect(html).not.toMatch(/shadow-|rounded-lg/);
  });

  test("Given the field, When rendered, Then it shares the transcript's measure", () => {
    // The composer sits under the column, so it has to BE the column. A
    // full-width field under a 68ch transcript is two different documents.
    expect(composer()).toContain("max-w-measure");
  });

  test("Given the send control, When rendered, Then its icon is drawn", () => {
    // Drawn, not typed: a glyph would be a character from whatever font the
    // system resolved, at whatever weight that font happened to have.
    const html = composer({ value: "ship it" });
    const at = html.indexOf("data-send");

    expect(at).toBeGreaterThanOrEqual(0);
    expect(html.slice(at)).toContain("<svg");
  });

  test("Given an empty draft, When rendered, Then send is disabled", () => {
    const at = composer().indexOf("data-send");

    expect(composer().slice(at - 200, at + 200)).toContain("disabled");
  });

  test("Given the hint and meta, When supplied, Then both sit on one line", () => {
    // The surface's words, not the package's. The composer prints what it is
    // handed and knows nothing about models or context windows.
    const html = composer({ hint: "claude-sonnet-4-6", meta: "39.8k / 200k" });

    expect(html).toContain("claude-sonnet-4-6");
    expect(html).toContain("39.8k / 200k");
  });
});

const tray = (count: number, onNext?: () => void) =>
  renderToStaticMarkup(
    <ApprovalTray
      onApprove={() => undefined}
      onDeny={() => undefined}
      onNext={onNext}
      pending={Array.from({ length: count }, (_, i) => ({
        toolId: `t${i}`,
        summary: `shell rm -rf build-${i}`,
        reason: "writes outside the workspace",
      }))}
    />,
  );

describe("the approval tray", () => {
  test("Given nothing pending, When rendered, Then the tray is absent", () => {
    // Not empty, not collapsed — absent. A permanent empty tray is a reserved
    // strip of screen that reports nothing for the entire session.
    expect(tray(0)).toBe("");
  });

  test("Given one pending call, When rendered, Then it is one line with two decisions", () => {
    const html = tray(1);

    expect(html).toContain("shell rm -rf build-0");
    expect(html).toContain("data-approve");
    expect(html).toContain("data-deny");
  });

  test("Given one pending call, When rendered, Then the reason is stated", () => {
    // The Owner is being asked to decide, so the tray owes them the WHY. A bare
    // command with two buttons trains reflexive approval.
    expect(tray(1)).toContain("writes outside the workspace");
  });

  test("Given several pending calls, When rendered, Then one is shown with a count and a way on", () => {
    // A stack of trays would push the composer off screen; a count plus `next`
    // keeps the decision surface exactly one line tall however deep the queue.
    const html = tray(3, () => undefined);

    expect(html).toContain("shell rm -rf build-0");
    expect(html).not.toContain("shell rm -rf build-1");
    expect(html).toContain("+2");
    expect(html).toContain("next");
  });

  test("Given a queue and no way to rotate, When rendered, Then the depth is still reported", () => {
    // The regression this file caught. The count used to be gated on the
    // rotation callback, so a surface that wired approve and deny but not `next`
    // displayed three blocked calls as one — the tray under-reporting the exact
    // situation it exists to surface.
    const html = tray(3);

    expect(html).toContain("+2");
    expect(html).not.toContain("next");
  });

  test("Given the tray, When rendered, Then only Approve takes the accent", () => {
    // Deny is destructive but it is also the SAFE default, so it must not be
    // dressed as the loud one. Approve is the action that lets work continue,
    // and it is the only thing on screen holding chroma.
    const html = tray(1);

    expect([...html.matchAll(/bg-accent\b/g)]).toHaveLength(1);
    // The single fill is on Approve specifically, not merely somewhere in the
    // tray. Slicing Deny's own element keeps this pinned to that control rather
    // than to a character window around it.
    const deny = html.indexOf("data-deny");
    const control = html.slice(html.lastIndexOf("<button", deny), html.indexOf("</button>", deny));
    expect(control).not.toContain("bg-accent");
  });
});
