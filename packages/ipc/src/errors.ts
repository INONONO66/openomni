export class IpcConnectionError extends Error {
  override name = "IpcConnectionError";
  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}

export class IpcTimeoutError extends Error {
  override name = "IpcTimeoutError";
}

export class IpcProtocolError extends Error {
  override name = "IpcProtocolError";
  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * The REMOTE handler failed (an error frame came back over a healthy
 * connection). Distinct from IpcConnectionError on purpose: a supervisor
 * deciding between "reconnect" and "the remote refused" must be able to
 * tell them apart by class (#606 audit).
 */
export class IpcRemoteError extends Error {
  override name = "IpcRemoteError";
  readonly code: number;

  constructor(code: number, message: string) {
    super(`IPC error ${code}: ${message}`);
    this.code = code;
  }
}
