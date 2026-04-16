export class IpcConnectionError extends Error {
  override name = "IpcConnectionError";
  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}

export class IpcTimeoutError extends Error {
  override name = "IpcTimeoutError";
  constructor(message: string) {
    super(message);
  }
}

export class IpcProtocolError extends Error {
  override name = "IpcProtocolError";
  constructor(message: string) {
    super(message);
  }
}
