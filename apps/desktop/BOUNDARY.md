# Desktop boundary

`apps/desktop` owns Electron composition, session selection, attention ordering, search, mock fixtures, and AI SDK chat state. It may depend on `ai`, `@ai-sdk/react`, `@openomni/ui`, and protocol contracts; it must not recreate kernel behavior.

## Chat state

The renderer owns one AI SDK `Chat<OpenOmniUIMessage>` per session and subscribes through `useChat`. `ai` and `@ai-sdk/react` remain application dependencies: the design system receives only its presentation contract.

- `src/renderer/chat/message.ts` defines the app's typed UI message and turn metadata.
- `src/renderer/chat/adapter.ts` is the sole `UIMessage` to `TranscriptNode` crossing. It derives transcript nodes, turn costs, and pending approvals from the chat's message list.
- `src/renderer/chat/gateway-transport.ts` translates the gateway wire protocol into an AI SDK `ChatTransport`.
- `src/renderer/chat/mock-transport.ts` provides the deterministic streamed transport used by the desktop mock surface.

`packages/ui` is data-blind. It imports neither `ai` nor `@ai-sdk/react`, does not name SDK message or tool-part types, and renders only `TranscriptNode`, costs, pending approvals, strings, and callbacks supplied by the app.
