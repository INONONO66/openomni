import { z } from "zod";
import { CodemodeError, DriverFailure, ForeignFailure, type CodeError } from "./errors";

export function decodeCodeFailure(operation: string) {
  return z.union([
    z.instanceof(CodemodeError), z.instanceof(DriverFailure), z.instanceof(ForeignFailure),
    z.preprocess(String, z.string()).transform((cause) => new ForeignFailure({ operation, cause })),
  ]).transform((error): CodeError => error).parse;
}
