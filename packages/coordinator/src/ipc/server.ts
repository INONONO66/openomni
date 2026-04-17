import { Ipc } from "@openomni/protocol";
import fs from "node:fs";

import { decodeMessage } from "./codec";
import { IpcProtocolError } from "./errors";
import { LineDecoder, encode } from "./framing";

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export type RequestHandler = (
  method: string,
  params: Record<string, unknown> | undefined,
  respond: (result: unknown) => void,
  notify: (method: string, params?: Record<string, unknown>) => void,
) => void;

export interface IpcServer {
  readonly socketPath: string;
  close(): void;
}

export function createIpcServer(socketPath: string, handler: RequestHandler): IpcServer {
  // Remove stale socket file so Bun.listen doesn't fail with EADDRINUSE.
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  interface SocketData {
    id: string;
  }

  interface BunSocket {
    data: unknown;
    write(data: Buffer | Uint8Array | string): number;
  }

  const connections = new Map<string, { socket: BunSocket; decoder: LineDecoder }>();
  let connCounter = 0;

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket: BunSocket) {
        const id = `conn-${++connCounter}`;
        (socket.data as unknown as SocketData) = { id };
        connections.set(id, { socket, decoder: new LineDecoder() });
      },
      data(socket: BunSocket, raw: Buffer) {
        const state = connections.get((socket.data as unknown as SocketData).id);
        if (!state) return;

        let messages: unknown[];
        try {
          messages = state.decoder.push(raw);
        } catch (error) {
          socket.write(
            encode(
              Ipc.createErrorResponse(
                "unknown",
                4001,
                error instanceof Error ? error.message : "invalid IPC frame",
              ),
            ),
          );
          return;
        }

        for (const msg of messages) {
          let parsed: Ipc.Request | Ipc.Response | Ipc.Notification;
          try {
            parsed = decodeMessage(msg);
          } catch (err) {
            if (err instanceof IpcProtocolError) {
              const errResponse = Ipc.createErrorResponse("unknown", 4000, err.message);
              socket.write(encode(errResponse));
            }
            continue;
          }

          if (parsed.type === "request") {
            const respond = (result: unknown) => {
              socket.write(encode(Ipc.createResponse(parsed.id, result)));
            };
            const notify = (method: string, params?: Record<string, unknown>) => {
              socket.write(encode(Ipc.createNotification(method, params)));
            };
            try {
              handler(parsed.method, parsed.params, respond, notify);
            } catch (err) {
              socket.write(
                encode(
                  Ipc.createErrorResponse(
                    parsed.id,
                    1000,
                    err instanceof Error ? err.message : String(err),
                  ),
                ),
              );
            }
          } else if (parsed.type === "notification") {
            // notifications don't get error responses per the protocol spec
            try {
              handler(
                parsed.method,
                parsed.params,
                () => undefined,
                () => undefined,
              );
            } catch (error) {
              console.warn(
                "coordinator IPC notification handler failed:",
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        }
      },
      close(socket: BunSocket) {
        const id = (socket.data as unknown as SocketData).id;
        connections.delete(id);
      },
      error(socket: BunSocket, _err: Error) {
        const id = (socket.data as unknown as SocketData).id;
        connections.delete(id);
        void socket;
      },
    },
  });

  return {
    socketPath,
    close() {
      server.stop(true);
      try {
        fs.unlinkSync(socketPath);
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    },
  };
}
