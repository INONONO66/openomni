import { Ipc, type IdSource, type PlainValue } from "@openomni/protocol";

import { IpcRemoteError, IpcTimeoutError } from "./errors";

/** One inbound frame after schema classification; the only place the three wire schemas are tried. */
type IpcMessage =
  | { readonly kind: "response"; readonly value: Ipc.Response }
  | { readonly kind: "request"; readonly value: Ipc.Request }
  | { readonly kind: "notification"; readonly value: Ipc.Notification };

/** `undefined` when `raw` matches no IPC message schema. */
type IpcWireInput = PlainValue | Ipc.Request | Ipc.Response | Ipc.Notification;

export function classifyIpcMessage(raw: IpcWireInput): IpcMessage | undefined {
  const response = Ipc.Response.safeParse(raw);
  if (response.success) return { kind: "response", value: response.data };
  const request = Ipc.Request.safeParse(raw);
  if (request.success) return { kind: "request", value: request.data };
  const notification = Ipc.Notification.safeParse(raw);
  if (notification.success) return { kind: "notification", value: notification.data };
  return undefined;
}

type PendingCall<TPeer> = {
  readonly peer: TPeer;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: Ipc.Response["result"]) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type SendFrame<TPeer> = (peer: TPeer, frame: Ipc.Request | Ipc.Response | Ipc.Notification) => void;

type RequestHandler<TPeer> = (
  peer: TPeer,
  method: string,
  params: Ipc.Request["params"],
  respond: (result: Ipc.Response["result"]) => void,
  notify: (method: string, params?: Ipc.Notification["params"]) => void,
) => void | Promise<void>;

type NotificationHandler<TPeer> = (
  peer: TPeer,
  method: string,
  params: Ipc.Notification["params"],
) => void | Promise<void>;

type PeerRequestTableOptions<TPeer> = {
  readonly send: SendFrame<TPeer>;
  readonly idSource?: IdSource;
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
    params: Ipc.Request["params"],
    timeoutMs: number,
  ): Promise<Ipc.Response["result"]> {
    const request = Ipc.createRequest(
      (this.options.idSource ?? (() => crypto.randomUUID()))(),
      method,
      params,
    );
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
  dispatch(raw: IpcWireInput, peer: TPeer): boolean {
    const message = classifyIpcMessage(raw);
    if (message === undefined) return false;
    this.dispatchMessage(message, peer);
    return true;
  }

  /** Route an already-classified frame; the server classifies once to answer unknown frames itself. */
  dispatchMessage(message: IpcMessage, peer: TPeer): void {
    switch (message.kind) {
      case "response":
        this.settleResponse(message.value, peer);
        return;
      case "request":
        this.dispatchRequest(message.value, peer);
        return;
      case "notification":
        this.dispatchNotification(message.value, peer);
        return;
    }
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

    const respond = (result: Ipc.Response["result"]) => {
      this.options.send(peer, Ipc.createResponse(request.id, result));
    };
    const notify = (method: string, params?: Ipc.Notification["params"]) => {
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
