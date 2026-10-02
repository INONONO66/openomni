import type { BrowserWindow, MenuItemConstructorOptions, WebContents } from "electron";
import { SHELL_COMMAND_CHANNEL, type ShellCommand } from "../preload/api";

interface MenuOptions {
  readonly platform: NodeJS.Platform;
  readonly development: boolean;
  readonly send: (command: ShellCommand) => void;
}

export function buildMenuTemplate({
  platform,
  development,
  send,
}: MenuOptions): MenuItemConstructorOptions[] {
  const command = (
    id: ShellCommand,
    label: string,
    accelerator: string,
  ): MenuItemConstructorOptions => ({
    id,
    label,
    accelerator,
    click: () => send(id),
  });
  return [
    ...(platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      id: "file",
      label: "File",
      submenu: [
        command("new-tab", "New Tab", "CommandOrControl+T"),
        command("close-tab", "Close Tab", "CommandOrControl+W"),
        command("reopen-tab", "Reopen Closed Tab", "CommandOrControl+Shift+T"),
        ...(platform === "darwin"
          ? []
          : [{ type: "separator" as const }, { role: "quit" as const }]),
      ],
    },
    { role: "editMenu" },
    {
      id: "view",
      label: "View",
      submenu: [
        command("back", "Back", "CommandOrControl+["),
        command("forward", "Forward", "CommandOrControl+]"),
        { type: "separator" },
        command("next-tab", "Next Tab", "Control+Tab"),
        command("previous-tab", "Previous Tab", "Control+Shift+Tab"),
        {
          ...command("next-tab", "Next Tab", "CommandOrControl+Shift+]"),
          id: "next-tab-alternate",
          visible: false,
          acceleratorWorksWhenHidden: true,
        },
        {
          ...command("previous-tab", "Previous Tab", "CommandOrControl+Shift+["),
          id: "previous-tab-alternate",
          visible: false,
          acceleratorWorksWhenHidden: true,
        },
        { type: "separator" },
        ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((ordinal) =>
          command(
            `select-tab-${ordinal}`,
            ordinal === 9 ? "Select Last Tab" : `Select Tab ${ordinal}`,
            `CommandOrControl+${ordinal}`,
          ),
        ),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(development
          ? [
              { type: "separator" as const },
              { role: "reload" as const },
              { role: "forceReload" as const },
              { role: "toggleDevTools" as const },
            ]
          : []),
      ],
    },
    {
      role: "windowMenu",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(platform === "darwin"
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : []),
      ],
    },
  ];
}

type CommandWindow = Pick<BrowserWindow, "id" | "isDestroyed"> & {
  readonly webContents: Pick<WebContents, "id" | "isDestroyed" | "send"> & {
    readonly devToolsWebContents: Pick<WebContents, "id"> | null;
  };
};

interface SenderOptions {
  readonly getFocusedWindow: () => CommandWindow | null;
  readonly getApplicationWindows: () => readonly CommandWindow[];
  readonly getLastFocusedWindowId: () => number | null;
}

export function createShellCommandSender({
  getFocusedWindow,
  getApplicationWindows,
  getLastFocusedWindowId,
}: SenderOptions): (command: ShellCommand) => void {
  return (command) => {
    const focused = getFocusedWindow();
    if (focused?.isDestroyed() || focused?.webContents.isDestroyed()) return;
    const windows = getApplicationWindows().filter(
      (window) => !window.isDestroyed() && !window.webContents.isDestroyed(),
    );
    const owner = focused
      ? windows.find((window) => window.id === focused.id) ??
        windows.find((window) => window.webContents.devToolsWebContents?.id === focused.webContents.id)
      : windows.find((window) => window.id === getLastFocusedWindowId());
    owner?.webContents.send(SHELL_COMMAND_CHANNEL, command);
  };
}
