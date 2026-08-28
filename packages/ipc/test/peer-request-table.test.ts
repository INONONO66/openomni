import { describe, expect, test } from "bun:test";
import { Ipc } from "@openomni/protocol";

import { IpcConnectionError, IpcRemoteError, IpcTimeoutError } from "../src/errors";
import { PeerRequestTable } from "../src/peer-request-table";

type Frame = Ipc.Request | Ipc.Response | Ipc.Notification;

function requestFrom(frames: Frame[], index = 0): Ipc.Request {
  const parsed = Ipc.Request.safeParse(frames[index]);
  if (!parsed.success) throw new Error(`frame ${index} was not a request`);
  return parsed.data;
}

describe("PeerRequestTable", () => {
  test("call issues an id and correlates the matching response", async () => {
    const sent: Frame[] = [];
    const table = new PeerRequestTable<string>({ send: (_peer, frame) => sent.push(frame) });

    const call = table.call("peer-a", "compute", { n: 21 }, 1_000);
    const request = requestFrom(sent);
    expect(request.id.length).toBeGreaterThan(0);
    expect(request.method).toBe("compute");
    expect(table.dispatch(Ipc.createResponse(request.id, { answer: 42 }), "peer-a")).toBe(true);
    expect(await call).toEqual({ answer: 42 });
  });

  test("a correlated error response rejects as IpcRemoteError", async () => {
    const sent: Frame[] = [];
    const table = new PeerRequestTable<string>({ send: (_peer, frame) => sent.push(frame) });

    const call = table.call("peer-a", "refuse", undefined, 1_000);
    const request = requestFrom(sent);
    table.dispatch(Ipc.createErrorResponse(request.id, 1000, "no"), "peer-a");

    const error = await call.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IpcRemoteError);
    expect(error).toMatchObject({ code: 1000, message: "IPC error 1000: no" });
  });

  test("response correlation and disconnect rejection are scoped to the owning peer", async () => {
    const sent: Frame[] = [];
    const table = new PeerRequestTable<string>({ send: (_peer, frame) => sent.push(frame) });
    const callA = table.call("peer-a", "a", undefined, 1_000);
    const callB = table.call("peer-b", "b", undefined, 1_000);
    const requestA = requestFrom(sent, 0);
    const requestB = requestFrom(sent, 1);
    let settledA = false;
    callA.then(
      () => {
        settledA = true;
      },
      () => {
        settledA = true;
      },
    );

    table.dispatch(Ipc.createResponse(requestA.id, "wrong peer"), "peer-b");
    expect(settledA).toBe(false);

    const disconnectError = new IpcConnectionError("peer-a closed");
    table.disconnect("peer-a", disconnectError);
    expect(await callA.catch((error: unknown) => error)).toBe(disconnectError);

    table.dispatch(Ipc.createResponse(requestB.id, "survived"), "peer-b");
    expect(await callB).toBe("survived");
  });

  test("call timeout rejects with IpcTimeoutError", async () => {
    const table = new PeerRequestTable({ send: () => undefined });
    const call = table.call(undefined, "slow", undefined, 10);
    const error = await call.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IpcTimeoutError);
    expect(error).toMatchObject({ message: "request timeout: slow" });
  });

  test("disconnectAll rejects calls across peers", async () => {
    const table = new PeerRequestTable<string>({ send: () => undefined });
    const first = table.call("peer-a", "a", undefined, 1_000);
    const second = table.call("peer-b", "b", undefined, 1_000);
    const error = new IpcConnectionError("endpoint closed");

    table.disconnectAll(error);
    expect(await first.catch((caught: unknown) => caught)).toBe(error);
    expect(await second.catch((caught: unknown) => caught)).toBe(error);
  });

  test("dispatch invokes inbound request handlers with response and notification senders", () => {
    const sent: Frame[] = [];
    const table = new PeerRequestTable<string>({
      send: (_peer, frame) => sent.push(frame),
      onRequest: (_peer, method, params, respond, notify) => {
        respond({ method, params });
        notify("request.observed", { method });
      },
    });

    expect(table.dispatch(Ipc.createRequest("echo", { value: 1 }), "peer-a")).toBe(true);
    expect(sent).toHaveLength(2);
    expect(Ipc.Response.parse(sent[0]).result).toEqual({ method: "echo", params: { value: 1 } });
    expect(Ipc.Notification.parse(sent[1])).toMatchObject({
      method: "request.observed",
      params: { method: "echo" },
    });
  });

  test("missing and throwing request handlers become code-1000 responses", () => {
    const missingFrames: Frame[] = [];
    const missing = new PeerRequestTable<string>({
      send: (_peer, frame) => missingFrames.push(frame),
      missingRequestHandlerMessage: (method) => `missing ${method}`,
    });
    missing.dispatch(Ipc.createRequest("none"), "peer-a");
    expect(Ipc.Response.parse(missingFrames[0]).error).toEqual({
      code: 1000,
      message: "missing none",
    });

    const failureFrames: Frame[] = [];
    const throwing = new PeerRequestTable<string>({
      send: (_peer, frame) => failureFrames.push(frame),
      onRequest: () => {
        throw new TypeError("handler failed");
      },
    });
    throwing.dispatch(Ipc.createRequest("boom"), "peer-a");
    expect(Ipc.Response.parse(failureFrames[0]).error).toEqual({
      code: 1000,
      message: "handler failed",
    });
  });

  test("dispatch delivers notifications and rejects unrecognized frames", () => {
    const observed: string[] = [];
    const table = new PeerRequestTable<string>({
      send: () => undefined,
      onNotification: (_peer, method) => {
        observed.push(method);
      },
    });

    expect(table.dispatch(Ipc.createNotification("event.ready"), "peer-a")).toBe(true);
    expect(table.dispatch({ type: "mystery" }, "peer-a")).toBe(false);
    expect(observed).toEqual(["event.ready"]);
  });
});
