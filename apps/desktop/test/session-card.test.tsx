import { setSessionAttention } from "../src/renderer/state/session-actions";
import { setSessionPhase } from "../src/renderer/state/session-actions";
import { beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { attentionKind, attentionScore, orderByAttention } from "../src/renderer/attention/order";
import { rowDensity } from "../src/renderer/attention/reason";
import { SessionList } from "../src/renderer/shell/session-list";
import { sessionGlyphProps } from "../src/renderer/shell/session-glyph";
import {
  consoleStore,
  INITIAL_CLIENT_STATE,
  openTab,
} from "../src/renderer/state/store";
import type { SessionPhase } from "../src/renderer/state/store";
import { renderShell } from "./helpers";
import { makeSession } from "./helpers/session";

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
    const list = renderToStaticMarkup(
      <SessionList now={now} sessions={[session]} onSelect={() => undefined} />,
    );
    expect(list).toContain(`data-tone="${tone}"`);
    expect(list).toContain(`data-shape="${shape}"`);
    const document = new Window().document;
    document.body.innerHTML = html + list;
    const tabIcon = document.querySelector('[data-ui="Tab.Icon"]');
    expect(tabIcon?.firstElementChild?.getAttribute("data-ui")).toBe("StatusGlyph");
    expect(tabIcon?.firstElementChild?.getAttribute("data-size")).toBe("compact");
    expect(tabIcon?.parentElement?.firstElementChild === tabIcon).toBe(true);
    const rows = document.querySelectorAll('[data-ui="TreeRow"] [data-ui="StatusGlyph"]');
    expect(rows).toHaveLength(2);
    for (const glyph of rows) {
      expect(glyph.parentElement?.lastElementChild).toBe(glyph);
      expect(glyph.parentElement?.firstElementChild).not.toBe(glyph);
      expect(glyph.getAttribute("data-shape")).toBe(shape);
      expect(glyph.getAttribute("data-tone")).toBe(tone);
    }
  });
}

test("row density follows content on both surfaces", () => {
  for (const [titleSource, phase, density] of [
    ["placeholder", "idle", "single"],
    ["prompt", "idle", "double"],
    ["placeholder", "running", "double"],
    ["placeholder", "waiting_input", "double"],
    ["placeholder", "completed", "double"],
    ["prompt", "failed", "double"],
  ] as const) {
    const session = makeSession({ titleSource, phase, title: "New Session" });
    expect(rowDensity(session)).toBe(density);
    consoleStore.setState((state) => ({ ...state, sessions: [session] }));
    const document = new Window().document;
    document.body.innerHTML =
      renderShell() +
      renderToStaticMarkup(
        <SessionList sessions={[session]} now={now} onSelect={() => undefined} />,
      );
    const glyphs = document.querySelectorAll('[data-ui="TreeRow"] [data-ui="StatusGlyph"]');
    expect(glyphs).toHaveLength(2);
    for (const glyph of glyphs) {
      const row = glyph.closest('[data-ui="TreeRow"]');
      expect(row?.getAttribute("data-density")).toBe(density);
      expect(row?.querySelectorAll("[data-secondary]")).toHaveLength(density === "single" ? 0 : 1);
      expect(glyph.getAttribute("data-size")).toBe("regular");
    }
  }
});

test("unread terminals report; snooze overrides demand; pin overrides snooze", () => {
  for (const phase of ["completed", "failed"] as const) {
    expect(attentionKind(makeSession({ phase, unread: true }), now)).toBe("report");
  }
  const session = makeSession({ phase: "waiting_input", snoozedUntil: now + 1 });
  expect(attentionKind(session, now)).toBe("rest");
  expect(attentionKind(session, now + 1)).toBe("demand");
  expect(attentionKind({ ...session, pinned: true }, now)).toBe("pinned");
  expect(attentionKind(makeSession({ phase: "idle", unread: false, lastActivityAt: 0 }), now)).toBe(
    "rest",
  );
});

test("score has a six-hour half-life and residue a 24-hour bonus", () => {
  const fresh = makeSession({ lastActivityAt: now });
  expect(attentionScore(fresh, now)).toBe(1);
  expect(attentionScore({ ...fresh, lastActivityAt: now - 6 * hour }, now)).toBeCloseTo(0.5);
  expect(attentionScore({ ...fresh, lastActivityAt: now - hour }, now)).toBeLessThan(1);
  expect(
    attentionScore({ ...fresh, phase: "interrupted", lastActivityAt: now - 24 * hour }, now),
  ).toBeCloseTo(0.5625);
});

test("kinds precede project best score; ties use session id, not input order", () => {
  const sessions = [
    makeSession({ id: "z", projectId: "alpha", lastActivityAt: now }),
    makeSession({ id: "a", projectId: "zeta", lastActivityAt: now }),
    makeSession({ id: "b", projectId: "zeta", lastActivityAt: now - hour }),
  ];
  const ordered = orderByAttention(sessions, now);
  expect(ordered.groups).toEqual([
    {
      kind: "rest",
      projects: [
        { id: "zeta", sessions: ["a", "b"] },
        { id: "alpha", sessions: ["z"] },
      ],
    },
  ]);
  expect(orderByAttention([...sessions].reverse(), now)).toEqual(ordered);
});

test("Sessions list paints every kind in order with matching glyphs", () => {
  const phases: SessionPhase[] = [
    "idle",
    "running",
    "interrupted",
    "failed",
    "waiting_input",
    "archived",
  ];
  const sessions = phases.map((phase, i) =>
    makeSession({ id: String(i), phase, unread: phase === "failed", pinned: phase === "archived" }),
  );
  const html = renderToStaticMarkup(
    <SessionList now={now} sessions={sessions} onSelect={() => undefined} />,
  );
  expect([...html.matchAll(/data-attention-kind="(\w+)"/g)].map((m) => m[1])).toEqual([
    "pinned",
    "demand",
    "report",
    "residue",
    "watch",
    "rest",
  ]);
  expect(html.match(/data-ui="StatusGlyph"/g)).toHaveLength(6);
  const ordered = orderByAttention(sessions, now);
  expect(ordered.groups.map((group) => group.kind)).toEqual([
    "pinned",
    "demand",
    "report",
    "residue",
    "watch",
    "rest",
  ]);
  expect(
    ordered.groups.flatMap((group) => group.projects.flatMap((project) => project.sessions)),
  ).toEqual(["5", "4", "3", "2", "1", "0"]);
  expect(orderByAttention([...sessions].reverse(), now)).toEqual(ordered);
});

test("scores decrease monotonically for every phase and clamp future activity", () => {
  for (const [phase] of cases) {
    const session = makeSession({ phase, lastActivityAt: now });
    let previous = attentionScore(session, now);
    expect(attentionScore(makeSession({ phase, lastActivityAt: now + hour }), now)).toBe(previous);
    for (const age of [1, 6, 24, 48]) {
      const score = attentionScore(session, now + age * hour);
      expect(score).toBeLessThan(previous);
      previous = score;
    }
  }
});

test("setters keep phase timestamps stable on repeated projections", () => {
  consoleStore.setState((s) => ({ ...s, sessions: [makeSession()] }));
  setSessionPhase("session", "running", now);
  setSessionPhase("session", "running", now + 1);
  setSessionAttention("session", { unread: true, pinned: true, snoozedUntil: now + hour });
  expect(consoleStore.state.sessions[0]).toMatchObject({
    phase: "running",
    phaseSince: now,
    lastActivityAt: now,
    unread: true,
    pinned: true,
    snoozedUntil: now + hour,
  });
});
