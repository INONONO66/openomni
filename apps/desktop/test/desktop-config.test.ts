import { describe, expect, test } from "bun:test";
import { resolveGatewayEndpoint } from "../src/main/gateway-endpoint";

/**
 * The main process is the only part of the desktop that may read the
 * environment, so the env-to-endpoint decision is pulled out of Electron and
 * asserted here as a pure function of a plain record.
 *
 * What has to be pinned is the FALLBACK, not the happy path: an explicit
 * `OPENOMNI_WS_URL` is trivially correct, while the derived loopback URL is a
 * copy of a default that lives in `apps/openomni/src/config.ts` and would
 * otherwise drift silently the day the daemon moves off port 3000.
 */

describe("the gateway endpoint is resolved from the environment", () => {
  test("Given an explicit URL, When resolved, Then it is used verbatim", () => {
    // Verbatim including the path: an operator pointing the console at a
    // reverse proxy has already said where the socket is, and appending `/ws`
    // to their answer would silently rewrite it.
    expect(resolveGatewayEndpoint({ OPENOMNI_WS_URL: "wss://gateway.example/socket" })).toEqual({
      url: "wss://gateway.example/socket",
    });
  });

  test("Given no URL but a port, When resolved, Then loopback carries that port", () => {
    expect(resolveGatewayEndpoint({ OPENOMNI_WS_PORT: "4100" })).toEqual({
      url: "ws://127.0.0.1:4100/ws",
    });
  });

  test("Given neither URL nor port, When resolved, Then the daemon's default port is used", () => {
    // 3000 is `parseWsPort`'s default in apps/openomni/src/config.ts. The
    // literal is copied rather than imported (the desktop topology forbids the
    // dependency), so this assertion is the copy's only alarm.
    expect(resolveGatewayEndpoint({})).toEqual({ url: "ws://127.0.0.1:3000/ws" });
  });

  test("Given a token, When resolved, Then it rides alongside the url", () => {
    expect(resolveGatewayEndpoint({ OPENOMNI_WS_TOKEN: "s3cret" })).toEqual({
      url: "ws://127.0.0.1:3000/ws",
      token: "s3cret",
    });
  });

  test("Given no token, When resolved, Then the key is absent rather than empty", () => {
    // `exactOptionalPropertyTypes` is on, and an empty-string token would be
    // offered to the gateway as a real credential and rejected.
    expect("token" in resolveGatewayEndpoint({ OPENOMNI_WS_TOKEN: "  " })).toBe(false);
    expect("token" in resolveGatewayEndpoint({})).toBe(false);
  });

  test("Given padded values, When resolved, Then they are trimmed before use", () => {
    expect(
      resolveGatewayEndpoint({ OPENOMNI_WS_URL: "  ws://host:9/ws  ", OPENOMNI_WS_TOKEN: " t " }),
    ).toEqual({ url: "ws://host:9/ws", token: "t" });
  });

  test("Given a blank URL, When resolved, Then the loopback fallback still applies", () => {
    // An exported-but-empty variable is the shape a shell script produces with
    // `export OPENOMNI_WS_URL=`; treating it as a URL would connect to nothing.
    expect(resolveGatewayEndpoint({ OPENOMNI_WS_URL: "   ", OPENOMNI_WS_PORT: "" })).toEqual({
      url: "ws://127.0.0.1:3000/ws",
    });
  });

  test("Given an unusable port, When resolved, Then the default is used instead of a broken url", () => {
    // The daemon throws on these; the console cannot, because refusing to open
    // a window over a bad env var would leave the Owner with no surface at all.
    for (const port of ["-1", "70000", "8080abc", "80.5"]) {
      expect(resolveGatewayEndpoint({ OPENOMNI_WS_PORT: port })).toEqual({
        url: "ws://127.0.0.1:3000/ws",
      });
    }
  });
});
