import { describe, expect, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { buildMenuTemplate, createShellCommandSender } from "../src/main/menu";
import { SHELL_COMMAND_CHANNEL, type ShellCommand } from "../src/preload/api";

const bindings: readonly (readonly [ShellCommand, string])[] = [
  ["new-tab", "CommandOrControl+T"],
  ["close-tab", "CommandOrControl+W"],
  ["reopen-tab", "CommandOrControl+Shift+T"],
  ["next-tab", "Control+Tab"],
  ["previous-tab", "Control+Shift+Tab"],
  ["back", "CommandOrControl+["],
  ["forward", "CommandOrControl+]"],
  ["select-tab-1", "CommandOrControl+1"],
  ["select-tab-2", "CommandOrControl+2"],
  ["select-tab-3", "CommandOrControl+3"],
  ["select-tab-4", "CommandOrControl+4"],
  ["select-tab-5", "CommandOrControl+5"],
  ["select-tab-6", "CommandOrControl+6"],
  ["select-tab-7", "CommandOrControl+7"],
  ["select-tab-8", "CommandOrControl+8"],
  ["select-tab-9", "CommandOrControl+9"],
];

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
  ]);
}

function click(item: MenuItemConstructorOptions | undefined): void {
  if (!item?.click) throw new Error("Missing command callback");
  Reflect.apply(item.click, undefined, []);
}

for (const platform of ["darwin", "win32", "linux"] as const) {
  for (const development of [false, true]) {
    describe(`${platform} ${development ? "development" : "production"} menu`, () => {
      test.each(bindings)("%s owns %s and dispatches its value", (command, accelerator) => {
        const sent: ShellCommand[] = [];
        const items = flatten(
          buildMenuTemplate({ platform, development, send: (c) => sent.push(c) }),
        );
        const item = items.find((entry) => entry.id === command);
        expect(item?.accelerator).toBe(accelerator);
        expect(item?.role).toBeUndefined();
        expect(items.filter((entry) => entry.accelerator === accelerator)).toHaveLength(1);
        click(item);
        expect(sent).toEqual([command]);
      });

      test("cycle aliases are separate hidden working accelerators", () => {
        const sent: ShellCommand[] = [];
        const items = flatten(
          buildMenuTemplate({ platform, development, send: (c) => sent.push(c) }),
        );
        for (const [command, accelerator] of [
          ["next-tab", "CommandOrControl+Shift+]"],
          ["previous-tab", "CommandOrControl+Shift+["],
        ] as const) {
          const item = items.find((entry) => entry.id === `${command}-alternate`);
          expect(item).toMatchObject({
            accelerator,
            visible: false,
            acceleratorWorksWhenHidden: true,
          });
          click(item);
        }
        expect(sent).toEqual(["next-tab", "previous-tab"]);
      });

      test("File and View are explicit, with no window-close or production debug escape", () => {
        const template = buildMenuTemplate({ platform, development, send: () => undefined });
        const items = flatten(template);
        const roles = items.map((item) => item.role);
        expect(roles).not.toContain("fileMenu");
        expect(roles).not.toContain("close");
        for (const id of ["file", "view"]) {
          const menu = template.find((item) => item.id === id);
          expect(menu).toBeDefined();
          expect(Array.isArray(menu?.submenu)).toBe(true);
          expect(menu?.role).toBeUndefined();
        }
        const view = template.find((item) => item.id === "view");
        if (!Array.isArray(view?.submenu)) throw new Error("Missing explicit View");
        const viewRoles = flatten(view.submenu).map((item) => item.role);
        for (const role of ["resetZoom", "zoomIn", "zoomOut", "togglefullscreen"] as const) {
          expect(viewRoles).toContain(role);
        }
        for (const role of ["reload", "forceReload", "toggleDevTools"] as const) {
          expect(roles.includes(role)).toBe(development);
          expect(viewRoles.includes(role)).toBe(development);
        }
        expect(roles).toContain("editMenu");
        expect(roles).toContain("windowMenu");
        expect(roles.includes("appMenu")).toBe(platform === "darwin");
        expect(
          items.filter((item) => item.accelerator === "CommandOrControl+W").map((item) => item.id),
        ).toEqual(["close-tab"]);
        const ids = items.flatMap((item) => (item.id ? [item.id] : []));
        expect(new Set(ids).size).toBe(ids.length);
      });
    });
  }
}

function recipient(id: number) {
  const sent: { channel: string; command: ShellCommand }[] = [];
  return {
    id,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: {
      id: id * 10,
      destroyed: false,
      devToolsWebContents: null as { id: number } | null,
      isDestroyed() {
        return this.destroyed;
      },
      send(channel: string, command: ShellCommand) {
        sent.push({ channel, command });
      },
    },
    sent,
  };
}

describe("live application recipient", () => {
  test("resolves focus on each menu click rather than capturing the initial owner", () => {
    const first = recipient(1);
    const second = recipient(2);
    let focused = first;
    const send = createShellCommandSender({
      getFocusedWindow: () => focused,
      getApplicationWindows: () => [first, second],
      getLastFocusedWindowId: () => first.id,
    });
    const item = flatten(buildMenuTemplate({ platform: "darwin", development: false, send })).find(
      (entry) => entry.id === "close-tab",
    );
    click(item);
    focused = second;
    click(item);
    expect(first.sent).toEqual([{ channel: SHELL_COMMAND_CHANNEL, command: "close-tab" }]);
    expect(second.sent).toEqual(first.sent);
  });

  test("no owner, destroyed window, destroyed webContents, or removed owner is a no-op", () => {
    const owner = recipient(1);
    let windows: ReturnType<typeof recipient>[] = [];
    const send = createShellCommandSender({
      getFocusedWindow: () => null,
      getApplicationWindows: () => windows,
      getLastFocusedWindowId: () => owner.id,
    });
    send("new-tab");
    windows = [owner];
    owner.destroyed = true;
    send("new-tab");
    owner.destroyed = false;
    owner.webContents.destroyed = true;
    send("new-tab");
    windows = [];
    owner.webContents.destroyed = false;
    send("new-tab");
    expect(owner.sent).toEqual([]);
  });

  test("destroyed focused webContents never redirects to a different last owner", () => {
    const focused = recipient(1);
    const previous = recipient(2);
    focused.webContents.destroyed = true;
    createShellCommandSender({
      getFocusedWindow: () => focused,
      getApplicationWindows: () => [focused, previous],
      getLastFocusedWindowId: () => previous.id,
    })("close-tab");
    expect(focused.sent).toEqual([]);
    expect(previous.sent).toEqual([]);
  });

  test("unowned focused windows never redirect to an unrelated application window", () => {
    const tools = recipient(1);
    const previous = recipient(2);
    createShellCommandSender({
      getFocusedWindow: () => tools,
      getApplicationWindows: () => [previous],
      getLastFocusedWindowId: () => previous.id,
    })("close-tab");
    expect(tools.sent).toEqual([]);
    expect(previous.sent).toEqual([]);
  });

  test("native menu blur retains a live owner without requiring renderer focus", () => {
    const owner = recipient(1);
    createShellCommandSender({
      getFocusedWindow: () => null,
      getApplicationWindows: () => [owner],
      getLastFocusedWindowId: () => owner.id,
    })("back");
    expect(owner.sent).toEqual([{ channel: SHELL_COMMAND_CHANNEL, command: "back" }]);
  });

  test("detached DevTools resolves its application owner, never its own webContents", () => {
    const first = recipient(1);
    const owner = recipient(2);
    const tools = recipient(3);
    owner.webContents.devToolsWebContents = tools.webContents;
    createShellCommandSender({
      getFocusedWindow: () => tools,
      getApplicationWindows: () => [first, owner],
      getLastFocusedWindowId: () => first.id,
    })("forward");
    expect(owner.sent).toEqual([{ channel: SHELL_COMMAND_CHANNEL, command: "forward" }]);
    expect(first.sent).toEqual([]);
    expect(tools.sent).toEqual([]);
  });
});
