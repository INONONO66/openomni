import { expect, test } from "bun:test";
import { z } from "zod";
import { testClockRuntime } from "./helpers/effect";
import { fetchWithRetry } from "../src/support/fetch-retry";
import { RateLimited } from "../src/errors";

/**
 * Exhaustion contract (#716, re-pinned on the Effect clock for #1248): three
 * retries sleep the hinted 5s on the injected clock — no wall-clock waits —
 * and the fourth outcome decides: a fourth 429 is a typed `RateLimited` with
 * full evidence; a network throw or any non-429 response passes through
 * unchanged. The publish warn (fired right before each retry sleep) is the
 * exact signal the test awaits before advancing the clock.
 */
for (const finalOutcome of ["refused", "network", "server", "accepted"] as const) {
  test(`retry exhaustion preserves ${finalOutcome} evidence after earlier refusals`, async () => {
    const originalFetch = globalThis.fetch;
    const clock = testClockRuntime();
    const response = Response.json(
      { code: "last_response" },
      {
        status: finalOutcome === "refused" ? 429 : finalOutcome === "server" ? 503 : 200,
        headers: { "retry-after": "7" },
      },
    );
    const networkError = new TypeError("rate limited after 3 retries (429)");
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        if (requests < 4) return Response.json({ code: "earlier_response" }, { status: 429 });
        if (finalOutcome === "network") throw networkError;
        return response;
      },
      { preconnect: originalFetch.preconnect },
    );
    let sleeping = Promise.withResolvers<number>();
    const retryAfters: number[] = [];
    try {
      const result = fetchWithRetry(
        "https://provider.test/send",
        { method: "POST" },
        {
          traceId: "exhausted",
          run: clock.run,
          publish: (_event, data) => {
            const warning = z
              .object({ context: z.object({ retryAfter: z.number() }) })
              .parse(data);
            retryAfters.push(warning.context.retryAfter);
            sleeping.resolve(warning.context.retryAfter);
          },
        },
      ).then(
        (value) => value,
        (failure: Error) => failure,
      );
      for (let retry = 0; retry < 3; retry++) {
        const seconds = await sleeping.promise;
        sleeping = Promise.withResolvers<number>();
        await clock.adjust(seconds * 1000);
      }
      const received = await result;
      expect(requests).toBe(4);
      expect(retryAfters).toEqual([5, 5, 5]);
      if (finalOutcome === "refused") {
        expect(received).toMatchObject({ _tag: "RateLimited" });
        if (!(received instanceof RateLimited))
          throw new Error("missing typed exhaustion evidence");
        expect(received.attempts).toBe(4);
        expect(received.status).toBe(429);
        expect(received.responseHeaders["retry-after"]).toBe("7");
        expect(z.object({ code: z.string() }).parse(JSON.parse(received.responseBody))).toEqual({
          code: "last_response",
        });
      } else {
        expect(received).toBe(finalOutcome === "network" ? networkError : response);
      }
    } finally {
      globalThis.fetch = originalFetch;
      await clock.dispose();
    }
  }, 15000);
}
