# Desktop boundary

`apps/desktop` owns Electron composition, session selection, attention ordering, search, mock fixtures, and AI SDK chat state. It may depend on `ai`, `@ai-sdk/react`, `@openomni/ui`, and protocol contracts; it must not recreate kernel behavior.

## Chat state

The renderer owns one AI SDK `Chat<OpenOmniUIMessage>` per session and subscribes through `useChat`. `ai` and `@ai-sdk/react` remain application dependencies: the design system receives only its presentation contract.

- `src/renderer/chat/message.ts` defines the app's typed UI message and turn metadata.
- `src/renderer/chat/adapter.ts` is the sole `UIMessage` to `TranscriptNode` crossing. It derives transcript nodes, turn costs, and pending approvals from the chat's message list.
- `src/renderer/chat/gateway-transport.ts` translates the gateway wire protocol into an AI SDK `ChatTransport`.
- `src/renderer/chat/mock-transport.ts` provides the deterministic streamed transport used by the desktop mock surface.
- `src/renderer/chat/select-transport.ts` is the pure choice between them, made once in `main.tsx` before the first paint. A `Chat` takes its transport at construction, so a shell that mounted first and swapped later would leave the Owner typing into a fixture that looks live.

## Where the gateway is

Only the Electron main process reads the environment; the renderer runs with `contextIsolation` on, `nodeIntegration` off, and `sandbox` on, and asks across one `contextBridge` call.

| Piece | Owns |
| --- | --- |
| `src/main/gateway-endpoint.ts` | `env -> { url, token? }`, pure. `OPENOMNI_WS_URL`, else `ws://127.0.0.1:<OPENOMNI_WS_PORT or 3000>/ws` |
| `src/main/index.ts` | Reads `process.env` once at startup and answers `ipcMain.handle(GATEWAY_CHANNEL)` |
| `src/preload/api.ts` | The shared leaf: `DesktopApi`, `GatewayEndpoint`, and the one channel literal. Zero imports |
| `src/preload/index.ts` | `ipcRenderer.invoke` behind `window.desktop.gateway()`. Stays CJS (`index.cjs`) because a sandboxed preload cannot be ESM |
| `src/renderer/main.tsx` | Asks the bridge, selects the transport, mounts |

The port default `3000` and the `/ws` path are **copied** from `apps/openomni/src/config.ts` (`parseWsPort`) and `apps/openomni/src/index.ts` (`createHttpRoutes`), with the source named at each literal: the topology allows `apps/desktop` to depend on `protocol` and `ui` only, so the console must not pull the deployable app in to learn a number. `test/gateway-endpoint.test.ts` is the copies' alarm.

The token travels as the WebSocket subprotocol pair `["auth", token]`, which is what `packages/channels/src/authn/websocket.ts` reads. No token means no offer at all rather than an empty one.

A renderer with no bridge behind it — the showcase, `scripts/shoot-chat.ts` — gets `undefined` and falls back to the mock, which is a correct answer rather than a degraded one.

`packages/ui` is data-blind. It imports neither `ai` nor `@ai-sdk/react`, does not name SDK message or tool-part types, and renders only `TranscriptNode`, costs, pending approvals, strings, and callbacks supplied by the app.
