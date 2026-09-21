import { expect, test } from "bun:test";
import { z } from "zod";
import { controlledTimeouts } from "./helpers/timeouts";
import { fetchWithRetry } from "../src/support/fetch-retry";
import { RateLimited } from "../src/errors";

for (const finalOutcome of ["refused", "network", "server", "accepted"] as const) {
  test(`retry exhaustion preserves ${finalOutcome} evidence after earlier refusals`, async () => {
    const originalFetch = globalThis.fetch;
    const response = Response.json(
      { code: "last_response" },
      {
        status: finalOutcome === "refused" ? 429 : finalOutcome === "server" ? 503 : 200,
        headers: { "retry-after": "7" },
      },
    );
    const networkError = new TypeError("rate limited after 3 retries (429)");
    let requests = 0;
    const timer = controlledTimeouts();
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        if (requests < 4) return Response.json({ code: "earlier_response" }, { status: 429 });
        if (finalOutcome === "network") throw networkError;
        return response;
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      const result = fetchWithRetry(
        "https://provider.test/send",
        { method: "POST" },
        {
          traceId: "exhausted",
        },
      ).then(
        (value) => value,
        (failure: Error) => failure,
      );
      for (let retry = 0; retry < 3; retry++) await timer.fireNext();
      const received = await result;
      expect(requests).toBe(4);
      expect(timer.delays).toEqual([5000, 5000, 5000]);
      if (finalOutcome === "refused") {
        expect(received).toMatchObject({ _tag: "RateLimited" });
        if (!(received instanceof RateLimited))
          throw new Error("missing typed exhaustion evidence");
        expect(received.attempts).toBe(4);
        expect(received.status).toBe(429);
        expect(received.responseHeaders["retry-after"]).toBe("7");
        expect(z.object({ code: z.string() }).parse(JSON.parse(received.responseBody))).toEqual({ code: "last_response" });
      } else {
        expect(received).toBe(finalOutcome === "network" ? networkError : response);
      }
    } finally {
      timer.restore();
      globalThis.fetch = originalFetch;
    }
  }, 15000);
}
