import { Data } from "effect";
import type { MachinesFailure } from "../errors";

export class IpcConnectionError extends Data.TaggedError("IpcConnectionError")<{
  readonly message: string;
  readonly cause?: string;
}> {}
export class IpcTimeoutError extends Data.TaggedError("IpcTimeoutError")<{
  readonly message: string;
  readonly cause?: string;
  readonly requestId: string;
  readonly method: string;
}> {}
export class IpcProtocolError extends Data.TaggedError("IpcProtocolError")<{
  readonly message: string;
  readonly cause?: string;
}> {}
/**
 * The server failed host-identity verification (#1270): either the TLS chain
 * did not validate against the configured host certificate (`code` carries
 * the OpenSSL X509 verify code, `presented` is the literal "unverified"
 * because the handshake aborted before a peer certificate was readable), or
 * the chain validated but the presented key's fingerprint differs from the
 * host certificate's. Raised by the client BEFORE any frame is sent; there is
 * no fallback path.
 */
export class IpcPeerKeyMismatchError extends Data.TaggedError("IpcPeerKeyMismatchError")<{
  readonly message: string;
  readonly expected: string;
  readonly presented: string;
  /** The OpenSSL X509 verify code when chain validation itself failed. */
  readonly code?: string;
}> {}
export class IpcRemoteError extends Data.TaggedError("IpcRemoteError")<{
  readonly message: string;
  readonly cause?: string;
  readonly requestId: string;
  readonly method: string;
  readonly code: number;
}> {}

/**
 * The bounded callback dispatcher refused a task because its queue is at the
 * injected bound (#1312): typed backpressure, never a silent drop.
 */
export class IpcQueueFullError extends Data.TaggedError("IpcQueueFullError")<{
  readonly message: string;
  readonly bound: number;
}> {}

export type IpcError = MachinesFailure | IpcConnectionError | IpcTimeoutError | IpcProtocolError | IpcRemoteError | IpcPeerKeyMismatchError | IpcQueueFullError;
