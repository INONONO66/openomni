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
 * The presented TLS peer key does not equal the pinned fingerprint (#1270).
 * Raised by the client BEFORE any frame is sent; there is no fallback path.
 */
export class IpcPeerKeyMismatchError extends Data.TaggedError("IpcPeerKeyMismatchError")<{
  readonly message: string;
  readonly expected: string;
  readonly presented: string;
}> {}
export class IpcRemoteError extends Data.TaggedError("IpcRemoteError")<{
  readonly message: string;
  readonly cause?: string;
  readonly requestId: string;
  readonly method: string;
  readonly code: number;
}> {}

export type IpcError = MachinesFailure | IpcConnectionError | IpcTimeoutError | IpcProtocolError | IpcRemoteError | IpcPeerKeyMismatchError;
