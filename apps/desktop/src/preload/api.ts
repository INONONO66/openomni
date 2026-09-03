/** Contract exposed to the renderer via contextBridge. Leaf file: zero imports. */
export interface DesktopApi {
  readonly versions: { readonly electron: string; readonly chrome: string; readonly node: string };
}

declare global {
  interface Window {
    readonly desktop: DesktopApi;
  }
}
