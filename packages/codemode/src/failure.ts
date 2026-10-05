import { z } from "zod";
import { machinesFallback, MachinesFailure } from "@openomni/machines";
import { CodemodeError, DriverFailure, type CodeError } from "./errors";

export function decodeCodeFailure(operation: string) {
  return z.union([
    z.instanceof(CodemodeError), z.instanceof(DriverFailure), z.instanceof(MachinesFailure),
    machinesFallback(operation),
  ]).transform((error): CodeError => error).parse;
}
