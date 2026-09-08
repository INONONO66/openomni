import { beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { attentionKind, attentionScore, orderByAttention } from "../src/renderer/attention/order";
import { SessionList } from "../src/renderer/shell/session-list";
import { sessionGlyphProps } from "../src/renderer/shell/session-glyph";
import { consoleStore, INITIAL_CLIENT_STATE, openTab, setSessionPhase, setSessionAttention } from "../src/renderer/state/store";
import type { SessionPhase } from "../src/renderer/state/store";
import { renderShell } from "./helpers";
import { makeSession } from "./make-session";

const now = 100_000_000;
const hour = 3_600_000;
beforeEach(() => consoleStore.setState(() => INITIAL_CLIENT_STATE));

const cases = [
  ["queued", "watch", "progress", "ring"],
  ["running", "watch", "progress", "spinner"],
  ["waiting_approval", "demand", "attention", "dot-pulse"],
  ["waiting_input", "demand", "attention", "dot-pulse"],
  ["interrupted", "residue", "muted", "pause"],
  ["completed", "rest", "success", "check"],
  ["failed", "rest", "destructive", "cross"],
  ["idle", "rest", "muted", "hollow"],
  ["archived", "rest", "faint", "hollow"],
] as const;
for (const [phase, kind, tone, shape] of cases) {
  test(`${phase} derives its kind and presentation`, () => {
    expect(attentionKind(makeSession({ phase }), now)).toBe(kind);
    expect(sessionGlyphProps(phase)).toEqual({ tone, shape });
  });
  test(`${phase} reaches the tab, sidebar and main header`, () => {
    const session = makeSession({ phase });
    consoleStore.setState((s) => ({ ...s, sessions: [session] }));
    openTab({ kind: "session", sessionId: session.id });
    const html = renderShell();
    expect(html.match(/data-ui="StatusGlyph"/g)).toHaveLength(3);
    expect(html.match(new RegExp(`data-tone="${tone}"`, "g"))).toHaveLength(3);
    expect(html.match(new RegExp(`data-shape="${shape}"`, "g"))).toHaveLength(3);
  });
}

test("unread terminals report; snooze overrides demand; pin overrides snooze", () => {
  for (const phase of ["completed", "failed"] as const) {
    expect(attentionKind(makeSession({ phase, unread: true }), now)).toBe("report");
  }
  const session = makeSession({ phase: "waiting_input", snoozedUntil: now + 1 });
  expect(attentionKind(session, now)).toBe("rest");
  expect(attentionKind(session, now + 1)).toBe("demand");
  expect(attentionKind({ ...session, pinned: true }, now)).toBe("pinned");
  expect(attentionKind(makeSession({ phase: "idle", unread: false, lastActivityAt: 0 }), now)).toBe("rest");
});

test("score has a six-hour half-life and residue a 24-hour bonus", () => {
  const fresh = makeSession({ lastActivityAt: now });
  expect(attentionScore(fresh, now)).toBe(1);
  expect(attentionScore({ ...fresh, lastActivityAt: now - 6 * hour }, now)).toBeCloseTo(0.5);
  expect(attentionScore({ ...fresh, lastActivityAt: now - hour }, now)).toBeLessThan(1);
  expect(attentionScore({ ...fresh, phase: "interrupted", lastActivityAt: now - 24 * hour }, now)).toBeCloseTo(0.5625);
});

test("kinds precede project best score; ties use session id, not input order", () => {
  const sessions = [
    makeSession({ id: "z", projectId: "alpha", lastActivityAt: now }),
    makeSession({ id: "a", projectId: "zeta", lastActivityAt: now }),
    makeSession({ id: "b", projectId: "zeta", lastActivityAt: now - hour }),
  ];
  const ordered = orderByAttention(sessions, now);
  expect(ordered.groups).toEqual([{ kind: "rest", projects: [
    { id: "zeta", sessions: ["a", "b"] }, { id: "alpha", sessions: ["z"] },
  ] }]);
  expect(orderByAttention([...sessions].reverse(), now)).toEqual(ordered);
});

test("Sessions list paints every kind in order with matching glyphs", () => {
  const phases: SessionPhase[] = ["idle", "running", "interrupted", "failed", "waiting_input", "archived"];
  const sessions = phases.map((phase, i) => makeSession({ id: String(i), phase, unread: phase === "failed", pinned: phase === "archived" }));
  const html = renderToStaticMarkup(<SessionList now={now} sessions={sessions} onSelect={() => {}} />);
  expect([...html.matchAll(/data-attention-kind="(\w+)"/g)].map((m) => m[1])).toEqual(["pinned", "demand", "report", "residue", "watch", "rest"]);
  expect(html.match(/data-ui="StatusGlyph"/g)).toHaveLength(6);
});

test("setters keep phase timestamps stable on repeated projections", () => {
  consoleStore.setState((s) => ({ ...s, sessions: [makeSession()] }));
  setSessionPhase("session", "running", now);
  setSessionPhase("session", "running", now + 1);
  setSessionAttention("session", { unread: true, pinned: true, snoozedUntil: now + hour });
  expect(consoleStore.state.sessions[0]).toMatchObject({ phase: "running", phaseSince: now, lastActivityAt: now, unread: true, pinned: true, snoozedUntil: now + hour });
});
