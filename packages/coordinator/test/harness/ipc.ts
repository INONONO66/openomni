export interface UnixSocketHandle {
  send: (msg: object) => void;
  close: () => void;
}
