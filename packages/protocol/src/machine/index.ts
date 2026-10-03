import * as Fold from "./fold.js";
import * as Schema from "./schema.js";
import { Events as MachineEvents } from "./events.js";

/**
 * Machine domain (docs/machines-and-delegation.md): attached devices as the
 * OS's body. Contracts only — the daemon runtime lives in the driver-band
 * `machines` package; enrollment storage lives in the ledger.
 */
export namespace Machine {
  export const CapabilityId = Schema.CapabilityId;
  export type CapabilityId = Schema.CapabilityId;
  export const WellKnownCapability = Schema.WellKnownCapability;
  export const MachineId = Schema.MachineId;
  export type MachineId = Schema.MachineId;
  export const KeyFingerprint = Schema.KeyFingerprint;
  export type KeyFingerprint = Schema.KeyFingerprint;
  export const fingerprintOf = Schema.fingerprintOf;
  export const WireMethod = Schema.WireMethod;
  export const AbsolutePath = Schema.AbsolutePath;
  export const ExecRequest = Schema.ExecRequest;
  export type ExecRequest = Schema.ExecRequest;
  export const ExecResult = Schema.ExecResult;
  export type ExecResult = Schema.ExecResult;
  export const CancelCode = Schema.CancelCode;
  export const CancelResult = Schema.CancelResult;
  export type CancelResult = import("zod").infer<typeof Schema.CancelResult>;
  export const PeekCode = Schema.PeekCode;
  export const PeekResult = Schema.PeekResult;
  export type PeekResult = import("zod").infer<typeof Schema.PeekResult>;
  export const FS_WRITE_MAX_BYTES = Schema.FS_WRITE_MAX_BYTES;
  export const EXEC_MAX_BYTES = Schema.EXEC_MAX_BYTES;
  export const EXEC_TIMEOUT_MS = Schema.EXEC_TIMEOUT_MS;
  export const Enrollment = Schema.Enrollment;
  export type Enrollment = Schema.Enrollment;
  export const Offer = Schema.Offer;
  export type Offer = Schema.Offer;
  export const AttachResult = Schema.AttachResult;
  export type AttachResult = Schema.AttachResult;
  export const CellRequest = Schema.CellRequest;
  export type CellRequest = Schema.CellRequest;
  export const CellResult = Schema.CellResult;
  export type CellResult = Schema.CellResult;
  export type CellOutput = Schema.CellOutput;
  export const CellState = Schema.CellState;
  export type CellState = Schema.CellState;
  export const CompletionRequest = Schema.CompletionRequest;
  export type CompletionRequest = Schema.CompletionRequest;
  export const ToolCall = Schema.ToolCall;
  export type ToolCall = Schema.ToolCall;
  export const ToolCallResult = Schema.ToolCallResult;
  export type ToolCallResult = Schema.ToolCallResult;
  export const FsRequest = Schema.FsRequest;
  export type FsRequest = Schema.FsRequest;
  export type FsValue = Schema.FsValue;
  export const FsResult = Schema.FsResult;
  export type FsResult = Schema.FsResult;
  export const ScreenRegion = Schema.ScreenRegion;
  export type ScreenRegion = Schema.ScreenRegion;
  export const ScreenReadRequest = Schema.ScreenReadRequest;
  export type ScreenReadRequest = Schema.ScreenReadRequest;
  export const ScreenReadResult = Schema.ScreenReadResult;
  export type ScreenReadResult = Schema.ScreenReadResult;
  export const InputAction = Schema.InputAction;
  export type InputAction = Schema.InputAction;
  export const InputWriteRequest = Schema.InputWriteRequest;
  export type InputWriteRequest = Schema.InputWriteRequest;
  export const InputWriteResult = Schema.InputWriteResult;
  export type InputWriteResult = Schema.InputWriteResult;
  export const SCREEN_PNG_MAX_BYTES = Schema.SCREEN_PNG_MAX_BYTES;
  export const SCREEN_AX_MAX_BYTES = Schema.SCREEN_AX_MAX_BYTES;
  export const INPUT_MAX_ACTIONS = Schema.INPUT_MAX_ACTIONS;
  export const INPUT_MAX_TEXT_CHARS = Schema.INPUT_MAX_TEXT_CHARS;
  export const FS_READ_MAX_BYTES = Schema.FS_READ_MAX_BYTES;
  export const FS_LIST_MAX_ENTRIES = Schema.FS_LIST_MAX_ENTRIES;

  export const effectiveCapabilities = Fold.effectiveCapabilities;
  export const effectiveExports = Fold.effectiveExports;

  export const Events = MachineEvents;
}
