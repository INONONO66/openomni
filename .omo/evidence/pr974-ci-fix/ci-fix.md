# PR974 pinned-Bun WebSocket CI fix

## Outcome and scope

Fixed and independently approved. The complete app suite (375 tests) and channel suite (400 tests) pass on Darwin Bun 1.3.6, Linux Bun 1.3.6, and Darwin Bun 1.4.1. The failing handshake is reproduced before the fix on both operating systems. No query fallback, timeout increase, sleep, skip, runtime upgrade, daemon redesign, or R1/R2 cleanup change is included.

- Task: `st_01a07369`; execution: 2026-09-05 21:11-21:37 UTC.
- Worktree: `/Users/ino/Develop/openomni-967-ws-auth`, branch `kernel/967-ws-auth`, upstream `origin/kernel/967-ws-auth`.
- Parent: `fcdcaa7f313ceb68671ac9178a03664bd5f21c6a`; parent tree: `111677bd109fa2f461d9df300e539069e6e3c357`.
- Verified code-only tree, before adding this evidence: `2b97c1f34d183b668926de466b47c7d4bfd5b601`.
- Code delta: five files, 62 insertions / 7 deletions. Production changes are only in three channel files; 53 lines are the new real-wire regression test. Evidence is separate under `.omo/evidence/pr974-ci-fix/` in the fix commit.
- This report is mirrored at `.omo/evidence/pr974-ci-fix/ci-fix.md`. Full raw receipts remain in the requested campaign directory's `a0/raw/ci-fix-*`, not all in the fix commit. `RAW_SHA256SUMS` anchors them. The three runnable probes are committed beside this report and mirrored in raw evidence.
- No push, PR update, hosted CI rerun, merge, or campaign-repository commit was performed.

## Exact root cause

`WebSocketHandler.handleUpgrade` previously passed the authenticated selection as `server.upgrade(req, { headers: { "Sec-WebSocket-Protocol": "auth" }, data })`.

Bun **1.3.6**, revision **d530ed993d62be7c7f8f01a3d52627b6845dfd93**, handles this twice in `src/bun.js/api/server.zig`:

1. Line 948 reads the explicit header into `sec_websocket_protocol`.
2. Line 979 calls `headers.toUWSResponse(...)`, writing that header to the HTTP response.
3. Lines 1014-1020 also pass the same selection to `resp.upgrade(...)`; uWebSockets emits its protocol header too.

Actual raw response from the smallest independent Bun server/client:

```text
HTTP/1.1 101 Switching Protocols
Sec-WebSocket-Protocol: auth
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
Sec-WebSocket-Protocol: auth
```

The Bun 1.3.6 client then emits **close 1002, `Mismatch client protocol`**, without opening. The app helper subscribes to open/error, not pre-open close, so its unchanged 2000 ms deadline reports the secondary symptom. The server accepted the token; this is neither an authentication denial nor slow app boot.

Lowercase header names and a `Headers` instance reproduce the same duplicate response. Bun **1.4.1**, revision **4661e494f052c83c80dade1318e5710238340be6**, emits one header and opens for all those representations.

Pinned source URL: `https://raw.githubusercontent.com/oven-sh/bun/bun-v1.3.6/src/bun.js/api/server.zig`; SHA256 `205de2ff7125b9d2f93527b604cc08598edba500ca7b9a4348ecfc4eacc689ee`. Captured as `raw/ci-fix-bun-server-136.zig`. This was a targeted source lookup after the wire reproduction, not broad research.

## Minimal fix

Authentication returns the selected `protocol` instead of response `headers`. Only **after successful authentication**, the WebSocket driver narrows `req.headers["sec-websocket-protocol"]` to that selection and calls `server.upgrade` without explicit response headers. Bun reads that nonempty request header for its native negotiation and writes the selected value once.

This preserves selection of `auth` even when an unrelated protocol precedes it; merely deleting the explicit response header without narrowing would incorrectly select that first protocol. Authentication still examines the original complete offer and compares tokens in constant time. Failed auth returns before mutation/upgrade. Tokenless/empty-token bootstrap remains unchanged, and cannot bind `?actor=`. Query credentials never become an auth input.

No compatibility wrapper or client-side workaround was added. The helper timeout behavior and all app production/test files are untouched (`git diff HEAD --exit-code -- apps/openomni` returned 0).

## RED and toggle evidence

Original hosted failure was read with:

```sh
gh run view 33992089598 --repo INONONO66/openomni --log-failed
```

`raw/ci-fix-original-ci.log`: job `101376214627`, **365 pass / 10 fail**, failures rooted at `apps/openomni/test/helpers/ws.ts:10` plus the dependent cleanup oracle.

Independent pinned runtime installation, without changing global Bun:

```sh
curl -fL https://github.com/oven-sh/bun/releases/download/bun-v1.3.6/bun-darwin-aarch64.zip -o /tmp/pr974-ci-fix-st_01a07369/bun.zip
unzip -q /tmp/pr974-ci-fix-st_01a07369/bun.zip -d /tmp/pr974-ci-fix-st_01a07369
/tmp/pr974-ci-fix-st_01a07369/bun-darwin-aarch64/bun --version
docker pull oven/bun:1.3.6-debian
```

ZIP SHA256: `2af1ec8437759ab05b3b0ea421fe9e22e6c705cb4cb0751c326982642dace8fa`.
Docker digest: `sha256:ef3b811897fedf7985166930302b867ebaefdff927fe705bdbe2fc6ca149367e`.
Linux platform: aarch64, Ubuntu host kernel `6.8.0-117-generic`, Debian container; same Bun revision as hosted CI. The shared Colima VM has 2 CPUs / 1.913 GiB RAM. This is real Linux runtime proof, **not** a fresh GitHub-hosted x86_64 CI result.

Before production edits:

```sh
# Darwin, repository root
/tmp/pr974-ci-fix-st_01a07369/bun-darwin-aarch64/bun test --timeout 15000 apps/openomni/test/e2e.test.ts -t 'real upgrade rejects'
# Linux, archived parent source at /work
# docker exec -w /work/apps/openomni pr974-st_01a07369-app:
bun test --timeout 15000 test/e2e.test.ts -t 'real upgrade rejects'
# Both platforms, packages/channels cwd, new test with old production source:
bun test test/websocket-upgrade.test.ts
```

- Real app on both platforms: **0 pass / 1 fail**, exit 1; query request returns 401 with zero provider calls/sessions, then canonical open times out after 2000 ms.
- New raw-wire regression on both platforms: **0 pass / 2 fail**, exit 1. Expected one `auth` header; received two. Both `auth, secret-token` and `other, auth, secret-token` fail for that exact reason.
- Receipts: `ci-fix-app-red-{darwin,linux}-136.log`, `ci-fix-header-red-{darwin,linux}-136.log`.

Committed `negotiation.ts` toggles **explicit header -> narrowed request -> explicit header**, with a real server/client and no app imports. `ci-fix-final-repro.log` records:

```text
Bun 1.3.6 Darwin: closed:1002:Mismatch client protocol -> open/auth/echo -> closed:1002:Mismatch client protocol
Bun 1.3.6 Linux:  closed:1002:Mismatch client protocol -> open/auth/echo -> closed:1002:Mismatch client protocol
Bun 1.4.1 Darwin: open/auth/echo -> open/auth/echo -> open/auth/echo
```

Run from the worktree with the desired independently installed runtime:

```sh
bun .omo/evidence/pr974-ci-fix/negotiation.ts
docker run --rm -i oven/bun:1.3.6-debian bun run - < .omo/evidence/pr974-ci-fix/negotiation.ts
```

The final probe subscribes to close as well as open/message/error, so RED completes on the actual 1002 event, not elapsed time. Original four-representation probes and logs are also retained.

## GREEN verification

Each complete package test command below passed in one run; no flaky retry or skipped failure:

```sh
cd packages/channels && bun test --timeout 15000
cd apps/openomni && bun test --timeout 15000
```

Darwin 1.3.6 used a command-local PATH prefix `/tmp/pr974-ci-fix-st_01a07369/bun-darwin-aarch64`. Darwin 1.4.1 used the unchanged global runtime. Linux used `docker exec -w /work/<package> pr974-st_01a07369-app bun test --timeout 15000`.

| Runtime | Channels | App | Receipt suffix |
| --- | --- | --- | --- |
| Darwin arm64 1.3.6 | 400 pass, 0 fail, 1157 assertions, 3.33s | 375 pass, 0 fail, 1127 assertions, 39.23s | `green-darwin-136.log` |
| Linux arm64 1.3.6 | 400 pass, 0 fail, 1157 assertions, 3.18s | 375 pass, 0 fail, 1127 assertions, 39.64s | `green-linux-136.log` |
| Darwin arm64 1.4.1 | 400 pass, 0 fail, 1157 assertions, 4.70s | 375 pass, 0 fail, 1127 assertions, 39.97s | `green-darwin-141.log` |

Receipts are prefixed `ci-fix-channels-` / `ci-fix-app-`. The cleanup oracle intentionally launches a rejecting child test; its enclosing test passes because real cleanup completed and the child exits 1. Its nested failure output is expected discrimination, not an unresolved suite failure.

Actual Linux app evidence includes:

- Query-only HTTP 401, providerCalls 0, session count 0; canonical response `A deterministic Resident reply.`, providerCalls 1, one idle resident session with 18 actions and persisted user/assistant turn.
- Actor message `c28d2337-b970-47a3-a62d-8558708dc8f3`, owner session `7d4f05a5-ce89-4f26-a16e-eda0d2274461`; Bob cannot settle Alice's Wait, Alice's reply settles it, exactly one internal settlement wake is persisted.
- Code-mode success: Python PID 3771 has native exit and close before the cleanup receipt; Unix socket and database directory absent. Injected-failure case owns PIDs 3777/3779 and observes both completions before socket/directory removal. The full suite observes ten interpreter exits/closes.
- Assertion-failure socket state CLOSED=3; directory absent. `U1_REAL_CLEANUP_RESOLVED` precedes the deliberate teardown rejection.

Static/build commands, all exit 0:

```sh
# Darwin, local node_modules/.bin prefixed to PATH:
bun run build --force --concurrency=2
tsc --noEmit -p apps/openomni/tsconfig.test.json
tsc --noEmit -p packages/channels/tsconfig.json
ultracite check --formatter-enabled=false packages/channels/src/authn/types.ts packages/channels/src/authn/websocket.ts packages/channels/src/websocket.ts packages/channels/test/websocket.test.ts packages/channels/test/websocket-upgrade.test.ts
# Linux container, Bun 1.3.6, native Node 20.19.2 only for the TS compiler:
NODE_OPTIONS=--max-old-space-size=512 bun run build --force --concurrency=1
node node_modules/typescript/bin/tsc --noEmit -p apps/openomni/tsconfig.test.json
node node_modules/typescript/bin/tsc --noEmit -p packages/channels/tsconfig.json
```

Both builds: **6 successful / 6 total, 0 cached**. Five changed production/test files: clean LSP diagnostics before build, clean lint. The three evidence probes also have clean diagnostics. Test file port typing was corrected before GREEN; no suppression. Source SHA256 values match exactly between Darwin and the Linux container (`ci-fix-source-cleanup.log`).

## Standalone real-app exercise

`manual.ts` boots the actual `startOpenOmni` composition and drives raw TCP HTTP upgrades and real WebSockets; only the LLM provider is the existing deterministic message fixture. It is not a paid-provider test and does not fabricate transport, SQLite, or cleanup behavior.

```sh
bun .omo/evidence/pr974-ci-fix/manual.ts
# Also executed with the absolute Darwin 1.3.6 binary and via:
docker exec pr974-st_01a07369-app bun .omo/evidence/pr974-ci-fix/manual.ts
```

All three runtimes exit 0. Both query-only and valid-query/wrong-subprotocol requests receive 401 before provider/session activity. Canonical and auth-not-first requests each receive 101 with exactly one `auth` header, then a real response frame. Exactly two idle resident sessions / 36 actions persist. Temporary directories are removed. Ports: Darwin1.3.6 52865, Darwin1.4.1 52872, Linux1.3.6 44529. Receipts: `ci-fix-manual-{darwin-136,darwin-141,linux-136}.log`.

## Independent review and bounded limitation

`ci-fix-independent-review.log`: a fresh read-only reviewer inspected the actual five-file delta, pinned source and RED/GREEN evidence, and independently ran `bun test test/websocket.test.ts test/websocket-upgrade.test.ts` once on Darwin1.3.6: **19 pass / 0 fail / 57 assertions**. Verdict **APPROVE**; no blocking finding. No reviewer source edit.

The evidence audit found a **separate Bun 1.3.6 client getter defect**: the actor test's late `ws.protocol` log reads `ine=` after message traffic, although its open-time `auth` assertions pass. `protocol-lifetime.ts` reproduces this without any app code, header mutation, or upgrade options: default `server.upgrade(request)`, protocol `auth` at open, then `xxxx` after receiving 4096 `x` bytes. This occurs on Darwin/Linux1.3.6;1.4.1 retains `auth`. No memory-level cause is claimed. Raw server response bytes and open-time assertions are the negotiation oracle, not this unreliable post-message getter. Actor correlation itself passes. Read-only review addendum agrees this independently reproduced runtime defect does not block the scoped handshake fix. No unrelated workaround was added.

## Execution corrections and cleanup

Not hidden or counted as RED/GREEN:

- An initial `/tmp` Docker bind was not shared through Colima; stdin transfer fixed the probe invocation.
- `--coverage=false` is invalid in Bun1.3.6; it was rejected before tests ran. Corrected commands use package CWDs without that flag.
- The isolated source archive's first install reached a failing Git hook because it had no `.git`. `git init` inside the disposable container allowed the frozen install to finish.
- Initial Linux `tsc` through Bun's node fallback was SIGKILLed under the shared 2 GiB VM limit. Installing native Node inside the owned container, bounding its compiler heap to 512 MiB and serializing the build produced the recorded uncached build/compiler GREEN. Bun test/runtime remained 1.3.6 throughout; no repo/CI runtime setting changed.
- First independent-review process could not find theme assets because of inherited `OMO_PACKAGE_DIR`/`SENPI_PACKAGE_DIR`; command-local unsetting corrected the launcher. Reviewer extension warnings in raw logs are not test output.

All owned containers, the exclusively introduced Bun1.3.6 image, downloaded pinned binary/archive and scratch source were removed. Docker image removal first raced container auto-removal and reported a conflict; after container removal completed it succeeded, without force or touching other containers. Final owned-container listing is empty. `.debug-journal.md` is removed. Global Bun remains **1.4.1+4661e494f**. Linux owned temp/socket inventory is empty; host listener checks for manual ports return exit1/no listener. No broad process kill or pre-existing fixture deletion was used.

Architecture review: source files retain their single responsibilities (auth result, authentication, WebSocket adapter). No new assertion escape hatch, defensive compatibility layer, generic helper, or variant branch was introduced. New test completion is exact-event driven with failure-only deadlines. Existing websocket unit file remains 239 nonblank/noncomment lines; no adjacent refactor was attempted. Evidence probes are deliberately not CI test targets.
