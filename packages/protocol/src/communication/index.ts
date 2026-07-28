import { Envelope as EnvelopeSchema } from "./envelope.js";

export namespace Communication {
  export const Envelope = EnvelopeSchema;
  export type Envelope = EnvelopeSchema;
}
