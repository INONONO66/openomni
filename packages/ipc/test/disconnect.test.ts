import { expect, test } from "bun:test";
import { connectIpcClient } from "../src/client";
import { createIpcServer } from "../src/server";
import { socketPath as socketPathForTest } from "./helpers/socket-path";

test("onDisconnect fires exactly once per torn-down connection", async () => {
  const socketPath = socketPathForTest("disconnect");
  const disconnects: string[] = [];
  let notifyDisconnect: (() => void) | undefined;
  const server = await createIpcServer(
    socketPath,
    (_method, _params, respond) => {
      respond({ ok: true });
    },
    {
      onDisconnect: (connectionId) => {
        disconnects.push(connectionId);
        notifyDisconnect?.();
      },
    },
  );
  try {
    const first = await connectIpcClient(socketPath);
    await first.call("ping", {});
    const second = await connectIpcClient(socketPath);
    await second.call("ping", {});

    const firstClosed = new Promise<void>((resolve) => {
      notifyDisconnect = resolve;
    });
    first.close();
    await firstClosed;
    expect(disconnects).toHaveLength(1);

    const secondClosed = new Promise<void>((resolve) => {
      notifyDisconnect = resolve;
    });
    second.close();
    await secondClosed;
    expect(disconnects).toHaveLength(2);
    expect(disconnects[0]).not.toBe(disconnects[1]);
  } finally {
    server.close();
  }
});

test("onDisconnect fires exactly once on abrupt socket destruction", async () => {
  const socketPath = socketPathForTest("abrupt");
  const disconnects: string[] = [];
  let notifyDisconnect: (() => void) | undefined;
  const server = await createIpcServer(
    socketPath,
    (_method, _params, respond) => {
      respond({ ok: true });
    },
    {
      onDisconnect: (connectionId) => {
        disconnects.push(connectionId);
        notifyDisconnect?.();
      },
    },
  );
  try {
    const { connect } = await import("node:net");
    const raw = connect(socketPath);
    await new Promise<void>((resolve) => raw.once("connect", () => resolve()));
    const torn = new Promise<void>((resolve) => {
      notifyDisconnect = resolve;
    });
    raw.destroy();
    await torn;
    expect(disconnects).toHaveLength(1);
  } finally {
    server.close();
  }
});
