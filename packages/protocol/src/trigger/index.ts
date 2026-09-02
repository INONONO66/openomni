import { canonicalDigest as digest } from "../json.js";
import { Events as EventDescriptors } from "./events.js";
import * as NotifierFold from "./notifier.js";
import * as SchedulerFold from "./scheduler.js";
import * as Schema from "./schema.js";

export namespace Trigger {
  export const Constants = Schema.Constants;
  export const Kinds = Schema.Kinds;
  export type KindName = Schema.KindName;
  export const LifecycleStates = Schema.LifecycleStates;
  export type LifecycleState = Schema.LifecycleState;
  export const FireStatuses = Schema.FireStatuses;
  export type FireStatus = Schema.FireStatus;
  export const SourceEventKinds = Schema.SourceEventKinds;

  export const CanonicalDigest = Schema.CanonicalDigest;
  export type CanonicalDigest = Schema.CanonicalDigest;
  export const canonicalDigest = digest;

  export const Source = Schema.Source;
  export type Source = Schema.Source;
  export const CreateSource = Schema.CreateSource;
  export type CreateSource = Schema.CreateSource;
  export const PauseReason = Schema.PauseReason;
  export type PauseReason = Schema.PauseReason;
  export const EndReason = Schema.EndReason;
  export type EndReason = Schema.EndReason;
  export const TerminalFireReason = Schema.TerminalFireReason;
  export type TerminalFireReason = Schema.TerminalFireReason;
  export const Lifecycle = Schema.Lifecycle;
  export type Lifecycle = Schema.Lifecycle;
  export const SourceItem = Schema.SourceItem;
  export type SourceItem = Schema.SourceItem;
  export const PendingBatch = Schema.PendingBatch;
  export type PendingBatch = Schema.PendingBatch;
  export const Record = Schema.Record;
  export type Record = Schema.Record;
  export const Create = Schema.Create;
  export type Create = Schema.Create;
  export const FireCause = Schema.FireCause;
  export type FireCause = Schema.FireCause;
  export const FireAdmission = Schema.FireAdmission;
  export type FireAdmission = Schema.FireAdmission;
  export const FireReservation = Schema.FireReservation;
  export type FireReservation = Schema.FireReservation;
  export const Fire = Schema.Fire;
  export type Fire = Schema.Fire;
  export const FireMaterial = Schema.FireMaterial;
  export type FireMaterial = Schema.FireMaterial;
  export const StoreErrorCode = Schema.StoreErrorCode;
  export type StoreErrorCode = Schema.StoreErrorCode;
  export const StoreError = Schema.StoreError;
  export type StoreError = InstanceType<typeof Schema.StoreError>;

  export const SchedulerInput = SchedulerFold.SchedulerInput;
  export type SchedulerInput = SchedulerFold.SchedulerInput;
  export const SchedulerEffect = SchedulerFold.SchedulerEffect;
  export type SchedulerEffect = SchedulerFold.SchedulerEffect;
  export namespace Scheduler {
    export const step = SchedulerFold.step;
  }

  export namespace Notifier {
    export const Event = NotifierFold.Event;
    export type Event = NotifierFold.Event;
    export const State = NotifierFold.State;
    export type State = NotifierFold.State;
    export const Effect = NotifierFold.Effect;
    export type Effect = NotifierFold.Effect;
    export type Result = NotifierFold.Result;
    export const initialState = NotifierFold.initialState;
    export const observe = NotifierFold.observe;
    export const flush = NotifierFold.flush;
    export const noteActivity = NotifierFold.noteActivity;
    export const rearm = NotifierFold.rearm;
    export const dispose = NotifierFold.dispose;
  }

  export const Events = EventDescriptors;
}
