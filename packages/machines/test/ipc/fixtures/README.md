# Test-only TLS fixtures

Self-signed EC (P-256) key pairs consumed by `packages/machines/test/ipc/network-tls.test.ts`:
`host-*` and `daemon-*` are the two pinned peers, `wrong-*` is the deliberately
mismatching identity. This is TEST-ONLY material — committed on purpose so tests
never depend on a key generator in the environment; nothing outside these tests
trusts or is trusted by these keys.
