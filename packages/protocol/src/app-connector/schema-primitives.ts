import { z } from "zod";

export const nonEmptyString = z.string().min(1);
export const commandArgs = z.array(nonEmptyString);
export const positiveInteger = z.number().int().positive();
