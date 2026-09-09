import { StatusGlyph, TreeRow } from "@openomni/ui";
import type { ComponentProps } from "react";
import { rowDensity } from "../attention/reason";
import type { Session } from "../state/store";
import { sessionGlyphProps } from "./session-glyph";
import { SessionSecondary } from "./session-secondary";

export function SessionRow({
  session,
  now,
  project,
  ...props
}: Omit<ComponentProps<typeof TreeRow>, "secondary" | "trailing"> & {
  readonly session: Session;
  readonly now: number;
  readonly project?: string;
}) {
  return (
    <TreeRow
      {...props}
      secondary={
        rowDensity(session) === "double" ? (
          <SessionSecondary
            session={session}
            now={now}
            {...(project === undefined ? {} : { project })}
          />
        ) : undefined
      }
      trailing={<StatusGlyph {...sessionGlyphProps(session.phase)} />}
    />
  );
}
