import { z } from "zod";
import { CodemodeError, CodemodeFailure, DriverFailure, type CodeError } from "./errors";

export function decodeCodeFailure(operation: string) {
  return z.union([
    z.instanceof(CodemodeError), z.instanceof(DriverFailure), z.instanceof(CodemodeFailure),
    z.preprocess(String, z.string()).transform((cause) => new CodemodeFailure({ operation, cause })),
  ]).transform((error): CodeError => error).parse;
}
