import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { formatRelative, sessionReason } from "../src/renderer/attention/reason";
import { consoleStore, INITIAL_CLIENT_STATE, openTab } from "../src/renderer/state/store";
import { renderShell } from "./helpers";
import { makeSession } from "./helpers/session";

const now = 1_000_000_000;

for (const [elapsed, expected] of [
  [-1, "now"],
  [0, "now"],
  [59_999, "now"],
  [60_000, "1m"],
  [120_000, "2m"],
  [4 * 3_600_000, "4h"],
  [3 * 86_400_000, "3d"],
] as const) {
  test(`relative time at offset ${elapsed} uses a compact whole unit`, () => {
    expect(formatRelative(now, now - elapsed)).toBe(expected);
  });
}

for (const phase of ["interrupted", "waiting_approval", "waiting_input", "running"] as const) {
  test(`${phase} shares activity time and render clock across both surfaces`, () => {
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const session = makeSession({
        phase,
        lastActivityAt: now - 120_000,
        phaseSince: now - 4 * 60_000,
      });
      consoleStore.setState(() => ({ ...INITIAL_CLIENT_STATE, sessions: [session] }));
      openTab({ kind: "route", route: "sessions" });
      const document = new Window().document;
      document.body.innerHTML = renderShell();
      const times = [...document.querySelectorAll('[data-ui="TreeRow"] time')];
      expect(times).toHaveLength(2);
      expect(times.map((time) => time.textContent?.trim())).toEqual(["2m", "2m"]);
      expect(times.map((time) => time.getAttribute("datetime"))).toEqual([
        new Date(session.lastActivityAt).toISOString(),
        new Date(session.lastActivityAt).toISOString(),
      ]);
      const reasons = [...document.querySelectorAll("[data-secondary]")].map((node) =>
        node.textContent?.includes(sessionReason(session, now)),
      );
      expect(reasons).toEqual([true, true]);
      if (phase !== "running") {
        for (const elapsed of [0, 4 * 60_000]) {
          const reason = sessionReason({ ...session, phaseSince: now - elapsed }, now);
          expect(reason.endsWith(formatRelative(now, now - elapsed))).toBe(true);
        }
      }
    } finally {
      clock.mockRestore();
      consoleStore.setState(() => INITIAL_CLIENT_STATE);
    }
  });
}
