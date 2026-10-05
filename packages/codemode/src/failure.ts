import { machinesFallback, MachinesFailure } from "@openomni/machines";
import { CodemodeError, DriverFailure, type CodeError } from "./errors";

export function decodeCodeFailure(operation: string) {
  return (error: unknown): CodeError =>
    error instanceof CodemodeError || error instanceof DriverFailure || error instanceof MachinesFailure
      ? error
      : machinesFallback(operation)(error);
}
