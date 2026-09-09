import type { ReactNode } from "react";
import { UI_NAMES } from "../names";

const PROSE = "font-sans text-[14px]/[21px] text-fg";
const CODE = "font-mono text-[13px]/[20px] text-fg";
const META = "font-mono text-[12px]/[18px] text-voice-meta";

type VoiceName = "prose" | "code" | "meta";

const VOICE: Record<VoiceName, string> = { prose: PROSE, code: CODE, meta: META };

export function Voice({
  voice,
  as: Tag = "span",
  className = "",
  children,
  ...rest
}: {
  readonly voice: VoiceName;
  readonly as?: "span" | "p" | "div" | "h2" | "li" | "button";
  readonly className?: string;
  readonly children?: ReactNode;
} & Omit<React.ComponentPropsWithoutRef<"span">, "className" | "children">) {
  return (
    <Tag
      className={`${VOICE[voice]} ${className}`}
      data-ui={UI_NAMES.Voice}
      data-voice={voice}
      {...rest}
    >
      {children}
    </Tag>
  );
}
