import { NamedError } from "@openomni/protocol";
import { z } from "zod";

const MessageData = z.object({ message: z.string() });
const IpcConnectionErrorBase = NamedError.create("IpcConnectionError", MessageData);
const IpcTimeoutErrorBase = NamedError.create("IpcTimeoutError", MessageData);
const IpcProtocolErrorBase = NamedError.create("IpcProtocolError", MessageData);
const IpcRemoteErrorBase = NamedError.create(
  "IpcRemoteError",
  z.object({ message: z.string(), code: z.number() }),
);

export class IpcConnectionError extends IpcConnectionErrorBase {
  constructor(message: string, cause?: unknown) {
    super({ message }, cause === undefined ? undefined : { cause });
  }
}

export class IpcTimeoutError extends IpcTimeoutErrorBase {
  constructor(message: string) {
    super({ message });
  }
}

export class IpcProtocolError extends IpcProtocolErrorBase {
  constructor(message: string, cause?: unknown) {
    super({ message }, cause === undefined ? undefined : { cause });
  }
}

/**
 * The REMOTE handler failed (an error frame came back over a healthy
 * connection). Distinct from IpcConnectionError on purpose: a supervisor
 * deciding between "reconnect" and "the remote refused" must be able to
 * tell them apart by class (#606 audit).
 */
export class IpcRemoteError extends IpcRemoteErrorBase {
  constructor(code: number, message: string) {
    super({ code, message: `IPC error ${code}: ${message}` });
  }

  get code(): number {
    return this.data.code;
  }
}
