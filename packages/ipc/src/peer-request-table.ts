import { Ipc } from "@openomni/protocol";

import { IpcRemoteError, IpcTimeoutError } from "./errors";

type PendingCall<TPeer> = {
  readonly peer: TPeer;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type SendFrame<TPeer> = (peer: TPeer, frame: Ipc.Request | Ipc.Response | Ipc.Notification) => void;

type RequestHandler<TPeer> = (
  peer: TPeer,
  method: string,
  params: Record<string, unknown> | undefined,
  respond: (result: unknown) => void,
  notify: (method: string, params?: Record<string, unknown>) => void,
) => void | Promise<void>;

type NotificationHandler<TPeer> = (
  peer: TPeer,
  method: string,
  params: Record<string, unknown> | undefined,
) => void | Promise<void>;

type PeerRequestTableOptions<TPeer> = {
  readonly send: SendFrame<TPeer>;
  readonly onRequest?: RequestHandler<TPeer>;
  readonly onNotification?: NotificationHandler<TPeer>;
  readonly missingRequestHandlerMessage?: (method: string) => string;
  readonly samePeer?: (pendingPeer: TPeer, inboundPeer: TPeer) => boolean;
};

/**
 * Owns the transport-neutral request lifecycle for one IPC endpoint: request
 * issuance, pending promise correlation, peer-scoped disconnect rejection,
 * and dispatch of inbound responses, requests, and notifications.
 */
export class PeerRequestTable<TPeer = undefined> {
  private readonly pending = new Map<string, PendingCall<TPeer>>();
  private readonly samePeer: (pendingPeer: TPeer, inboundPeer: TPeer) => boolean;

  constructor(private readonly options: PeerRequestTableOptions<TPeer>) {
    this.samePeer = options.samePeer ?? Object.is;
  }

  call(
    peer: TPeer,
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const request = Ipc.createRequest(method, params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new IpcTimeoutError(`request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(request.id, { peer, reject, resolve, timer });
      this.options.send(peer, request);
    });
  }

  /** Returns false when `raw` matches no IPC message schema. */
  dispatch(raw: unknown, peer: TPeer): boolean {
    const response = Ipc.Response.safeParse(raw);
    if (response.success) {
      this.settleResponse(response.data, peer);
      return true;
    }

    const request = Ipc.Request.safeParse(raw);
    if (request.success) {
      this.dispatchRequest(request.data, peer);
      return true;
    }

    const notification = Ipc.Notification.safeParse(raw);
    if (notification.success) {
      this.dispatchNotification(notification.data, peer);
      return true;
    }

    return false;
  }

  disconnect(peer: TPeer, error: Error): void {
    this.rejectPending(error, (pendingPeer) => this.samePeer(pendingPeer, peer));
  }

  disconnectAll(error: Error): void {
    this.rejectPending(error, () => true);
  }

  private settleResponse(response: Ipc.Response, peer: TPeer): void {
    const pending = this.pending.get(response.id);
    if (!pending || !this.samePeer(pending.peer, peer)) return;

    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new IpcRemoteError(response.error.code, response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private dispatchRequest(request: Ipc.Request, peer: TPeer): void {
    if (!this.options.onRequest) {
      const message =
        this.options.missingRequestHandlerMessage?.(request.method) ??
        `peer has no request handler for ${request.method}`;
      this.options.send(peer, Ipc.createErrorResponse(request.id, 1000, message));
      return;
    }

    const respond = (result: unknown) => {
      this.options.send(peer, Ipc.createResponse(request.id, result));
    };
    const notify = (method: string, params?: Record<string, unknown>) => {
      this.options.send(peer, Ipc.createNotification(method, params));
    };
    const failRequest = (error: unknown) => {
      this.options.send(
        peer,
        Ipc.createErrorResponse(
          request.id,
          1000,
          error instanceof Error ? error.message : String(error),
        ),
      );
    };

    try {
      const result = this.options.onRequest(peer, request.method, request.params, respond, notify);
      if (result instanceof Promise) result.catch(failRequest);
    } catch (error) {
      failRequest(error);
    }
  }

  private dispatchNotification(notification: Ipc.Notification, peer: TPeer): void {
    const warnFailure = (error: unknown) => {
      console.warn(
        "IPC notification handler failed:",
        error instanceof Error ? error.message : String(error),
      );
    };

    try {
      const result = this.options.onNotification?.(peer, notification.method, notification.params);
      if (result instanceof Promise) result.catch(warnFailure);
    } catch (error) {
      warnFailure(error);
    }
  }

  private rejectPending(error: Error, matches: (peer: TPeer) => boolean): void {
    for (const [id, pending] of this.pending) {
      if (!matches(pending.peer)) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
