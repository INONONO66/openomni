import net from "node:net";

export interface UnixSocketHandle {
  send: (msg: object) => void;
  close: () => void;
}

export function connectUnixSocket(socketPath: string, timeoutMs = 5000): Promise<UnixSocketHandle> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect timeout: ${socketPath}`));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve({
        send: (msg) => socket.write(`${JSON.stringify(msg)}\n`),
        close: () => socket.destroy(),
      });
    });

    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
