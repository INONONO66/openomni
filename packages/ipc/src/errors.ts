import { Data } from "effect";
import { z } from "zod";

const Diagnostic = z.object({ operation: z.string(), cause: z.string() });
export class ForeignFailure extends Data.TaggedError("ForeignFailure")<z.infer<typeof Diagnostic>> {
  override get message(): string { return this.cause; }
}
const MessageFields = z.object({ message: z.string(), cause: z.string().optional() });
export class IpcConnectionError extends Data.TaggedError("IpcConnectionError")<z.infer<typeof MessageFields>> {}
const RequestFields = MessageFields.extend({ requestId: z.string(), method: z.string() });
export class IpcTimeoutError extends Data.TaggedError("IpcTimeoutError")<z.infer<typeof RequestFields>> {}
export class IpcProtocolError extends Data.TaggedError("IpcProtocolError")<z.infer<typeof MessageFields>> {}
const RemoteFields = RequestFields.extend({ code: z.number() });
export class IpcRemoteError extends Data.TaggedError("IpcRemoteError")<z.infer<typeof RemoteFields>> {}

export type IpcError = ForeignFailure | IpcConnectionError | IpcTimeoutError | IpcProtocolError | IpcRemoteError;
