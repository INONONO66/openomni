import { useState, type ComponentProps } from "react";
import { Console } from "../src/console";
import { SHELL, STRIP } from "./fixture";

export function InteractiveTabs({
  records,
}: {
  readonly records: ComponentProps<typeof Console>["strip"]["tabs"];
}) {
  const [active, setActive] = useState("a");
  return (
    <Console
      shell={SHELL}
      sidebar={null}
      strip={{
        ...STRIP,
        tabs: records.map((tab) => ({ ...tab, active: tab.id === active })),
        onActivate: setActive,
      }}
    />
  );
}
