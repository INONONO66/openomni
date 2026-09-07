import { beforeEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/renderer/app";
import { StateProvider } from "../src/renderer/state/provider";
import { queryKeys } from "../src/renderer/state/queries";
import { consoleStore, createSession, INITIAL_CLIENT_STATE } from "../src/renderer/state/store";

/**
 * The shell's first paint, from the store and the endpoint query and nothing
 * else. There is no DOM here, so what is pinned is what each state renders TO:
 * an honest empty column, a created session named in the header and marked in
 * the tree, and a composer that says why it is disabled instead of pretending.
 */
beforeEach(() => {
  consoleStore.setState(() => INITIAL_CLIENT_STATE);
});

/** Render with the endpoint query already answered, or still in flight. */
function shell(endpoint: "pending" | null) {
  const client = new QueryClient();
  if (endpoint !== "pending") client.setQueryData(queryKeys.gatewayEndpoint, endpoint);
  return renderToStaticMarkup(
    <StateProvider client={client}>
      <App platform="darwin" storage={null} />
    </StateProvider>,
  );
}

describe("nothing open", () => {
  test("Given no sessions, When the app renders, Then both columns say so and nothing is fabricated", () => {
    const html = shell(null);

    expect(html).toContain("No sessions yet");
    expect(html).toContain("Select or create a session");
    expect(html).not.toContain('role="option"');
    // No composer: there is nothing to address a message to.
    expect(html).not.toContain("data-composer");
  });

  test("Given the endpoint still in flight, When the app renders, Then the window is already painted", () => {
    // The app must not wait on the wire: the navigator is useful before the
    // endpoint has answered.
    expect(shell("pending")).toContain('aria-label="Sessions"');
  });
});

describe("one session", () => {
  test("Given a created session, When the app renders, Then it is the header and the current row", () => {
    createSession(1);
    const html = shell(null);

    expect(html).toContain("Session 1");
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain("No turns in this session yet.");
    expect(html).not.toContain("No sessions yet");
  });

  test("Given no gateway, When the app renders, Then the composer is disabled and says why", () => {
    createSession(1);
    const html = shell(null);
    const field = html.slice(html.indexOf("<textarea"), html.indexOf("</textarea>"));

    expect(field).toContain("disabled");
    expect(html).toContain("gateway not configured");
  });

  test("Given the endpoint still in flight, When the app renders, Then the composer waits without a verdict", () => {
    createSession(1);
    const html = shell("pending");
    const field = html.slice(html.indexOf("<textarea"), html.indexOf("</textarea>"));

    expect(field).toContain("disabled");
    expect(html).not.toContain("gateway not configured");
  });
});
