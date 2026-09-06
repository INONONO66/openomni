import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Panel, Text } from "../src";
import { Inspector } from "./inspector";
import { ShellView } from "./sections/shell-view";
import { SystemView } from "./sections/system-view";
import "./styles.css";

type Theme = "dark" | "light";
type View = "system" | "shell";

/**
 * Two views over ONE token set. The Shell view is not a second design system:
 * it sets `data-density="shell"`, which re-points the type scale and the
 * vertical rhythm and touches no color. That is the claim this page exists to
 * make checkable — if the two views disagree on color, the system has forked.
 */
function Showcase() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [view, setView] = useState<View>("system");

  document.documentElement.dataset.theme = theme;

  return (
    <Panel className="min-h-screen" tone="bg">
      <Panel
        className="sticky top-0 z-10 flex h-titlebar items-center gap-section px-section"
        tone="bg"
      >
        <Text level="label" tone="fg">
          @openomni/ui
        </Text>
        <nav className="flex items-center gap-1">
          <Toggle active={view === "system"} label="System" onClick={() => setView("system")} />
          <Toggle active={view === "shell"} label="Shell" onClick={() => setView("shell")} />
        </nav>
        {/* The instrument is invisible until it is used, so the page has to say
            it exists. One line in the ambient tone, beside the views it
            inspects — a legend, not a control. */}
        <Text className="hidden lg:inline" level="micro" mono tone="faint">
          ⌥ hover · inspect
        </Text>
        <div className="ml-auto flex items-center gap-1">
          <Toggle active={theme === "dark"} label="Dark" onClick={() => setTheme("dark")} />
          <Toggle active={theme === "light"} label="Light" onClick={() => setTheme("light")} />
        </div>
      </Panel>
      {view === "system" ? <SystemView /> : <ShellView />}
      {/* Last, so its overlay stacks above both views without a z-index race,
          and OUTSIDE either one, so switching tabs cannot unmount the
          instrument mid-inspection. */}
      <Inspector />
    </Panel>
  );
}

function Toggle({
  label,
  active,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Button
      aria-pressed={active}
      onClick={onClick}
      size="sm"
      variant={active ? "secondary" : "ghost"}
    >
      {label}
    </Button>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("showcase root element missing");
createRoot(root).render(
  <StrictMode>
    <Showcase />
  </StrictMode>,
);
