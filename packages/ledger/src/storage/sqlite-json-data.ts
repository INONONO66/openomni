import { z } from "zod";

// Registry adapters validate the row envelope before decoding its persisted JSON.
export const SqliteJsonDataRowSchema = z.object({ data: z.string() });
export const SqliteJsonDataRowsSchema = z.array(SqliteJsonDataRowSchema);
