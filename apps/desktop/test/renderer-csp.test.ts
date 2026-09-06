import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The renderer's Content Security Policy, asserted as source.
 *
 * A CSP fails at RUNTIME and only at runtime: the build is green, the window
 * opens, and one subresource is silently refused. Both directives below were
 * added because exactly that happened — the gateway socket was blocked by
 * `default-src`, and the bundler's inlined font faces with it — so each is
 * pinned here rather than rediscovered the next time the policy is edited.
 */

const INDEX_HTML = join(import.meta.dir, "..", "src", "renderer", "index.html");

async function policy(): Promise<Readonly<Record<string, readonly string[]>>> {
  const html = await Bun.file(INDEX_HTML).text();
  const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/s.exec(html)?.[1];
  expect(content, "the renderer declares a Content-Security-Policy").toBeDefined();

  const directives: Record<string, readonly string[]> = {};
  for (const directive of (content ?? "").split(";")) {
    const [name, ...values] = directive.trim().split(/\s+/);
    if (name !== undefined && name.length > 0) directives[name] = values;
  }
  return directives;
}

describe("the renderer's content security policy", () => {
  test("Given the policy, When read, Then the document itself stays locked to its own origin", async () => {
    const directives = await policy();

    expect(directives["default-src"]).toEqual(["'self'"]);
    expect(directives["script-src"]).toEqual(["'self'"]);
  });

  test("Given the policy, When read, Then the gateway's socket schemes are connectable", async () => {
    // `default-src 'self'` does NOT cover `ws:` — a websocket to
    // `ws://127.0.0.1:3000/ws` from a `file://` document is a different origin
    // by every rule the browser applies, so without this directive the console
    // renders perfectly and never connects to anything.
    const connect = await policy().then((directives) => directives["connect-src"] ?? []);

    expect(connect).toContain("'self'");
    expect(connect).toContain("ws:");
    expect(connect).toContain("wss:");
  });

  test("Given the policy, When read, Then bundled fonts may load from data URIs", async () => {
    // The build inlines small font subsets as `data:` URLs. Under
    // `default-src 'self'` each one is refused and the surface falls back to a
    // system face — a silent regression of the whole type system.
    const font = await policy().then((directives) => directives["font-src"] ?? []);

    expect(font).toContain("'self'");
    expect(font).toContain("data:");
  });

  test("Given the policy, When read, Then no remote origin is admitted", async () => {
    // The console ships every asset it renders. A policy that admits an
    // `https:` origin is how a remote font or script gets in later without
    // anybody editing a stylesheet.
    const directives = await policy();

    for (const [name, values] of Object.entries(directives)) {
      for (const value of values) {
        expect(/^https?:/.test(value), `${name} admits ${value}`).toBe(false);
      }
    }
  });
});
