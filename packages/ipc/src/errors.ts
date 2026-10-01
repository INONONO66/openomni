import { Data } from "effect";

export class ForeignFailure extends Data.TaggedError("ForeignFailure")<{
  readonly operation: string;
  readonly cause: string;
}> {
  override get message(): string { return this.cause; }
}

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
export class IpcRemoteError extends Data.TaggedError("IpcRemoteError")<{
  readonly message: string;
  readonly cause?: string;
  readonly requestId: string;
  readonly method: string;
  readonly code: number;
}> {}

export type IpcError = ForeignFailure | IpcConnectionError | IpcTimeoutError | IpcProtocolError | IpcRemoteError;
