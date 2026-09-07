import { expect, spyOn, test } from "bun:test";
import { fetchWithRetry, RetryExhaustedError } from "../src/support/fetch-retry";

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
    let scheduled = Promise.withResolvers<() => void>();
    const timerHandle = setTimeout(() => undefined, 0);
    clearTimeout(timerHandle);
    const delays: number[] = [];
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(
      Object.assign(
        (callback: Parameters<typeof setTimeout>[0], delay?: number) => {
          delays.push(delay ?? 0);
          scheduled.resolve(() => callback());
          return timerHandle;
        },
        { __promisify__: setTimeout.__promisify__ },
      ),
    );
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
      for (let retry = 0; retry < 3; retry++) {
        const fire = await scheduled.promise;
        scheduled = Promise.withResolvers<() => void>();
        fire();
      }
      const received = await result;
      expect(requests).toBe(4);
      expect(delays).toEqual([5000, 5000, 5000]);
      if (finalOutcome === "refused") {
        expect(received).toBeInstanceOf(RetryExhaustedError);
        if (!(received instanceof RetryExhaustedError))
          throw new Error("missing typed exhaustion evidence");
        expect(received.attempts).toBe(4);
        expect(received.status).toBe(429);
        expect(received.response).toBe(response);
        expect(received.response.headers.get("retry-after")).toBe("7");
        expect(await received.response.json()).toEqual({ code: "last_response" });
      } else {
        expect(received).toBe(finalOutcome === "network" ? networkError : response);
      }
    } finally {
      timer.mockRestore();
      globalThis.fetch = originalFetch;
    }
  }, 15000);
}
