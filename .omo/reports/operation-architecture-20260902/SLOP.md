# 슬롭 제거 대장 (누적, 2026-09-02)

발견된 슬롭은 전부 여기 기록한다. 커널 재설계(`KERNEL.md`) 이관 PR마다 해당 행을 닫는다. 출처: consumption-audit-20260902, slop-audit-20260901, semantic-map-20260902, 세션 토론.
규칙: **소비자 없는 프리미티브 머지 불가** — 발행자 0 이벤트 / 호출자 0 export / 소비자 0 스토어는 센서스 게이트로 CI에서 잡는다.

상태: 🗑 삭제 · 🔌 배선(소비자 연결) · 🔁 커널 이관으로 대체 · 🐛 결함 수정 · ⏳ 정책 결정 대기

## A. 죽어 있는 프리미티브 (dormant 7 + 추가)

| # | 대상 | 위치 | 처분 |
|---|---|---|---|
| ~~A1~~ | `TranscriptStore` | packages/ledger | ✅ #944 PR #963 — 저장소·SQLite 어댑터·배럴·테스트 삭제, `transcript_fact`는 비어 있을 때만 forward migration으로 drop |
| ~~A2~~ | `claimSurface` | packages/channels | ✅ #944 PR #963 — 호출자 없는 라우터 인터페이스·구현·테스트 삭제 |
| A3 | Delegation `continue` arm | protocol/apps delegation | 🗑 |
| A4 | `EngagementStore` + engagement 전이 | packages/ledger, protocol | 🗑 (D2) |
| ~~A5~~ | `McpClient` | packages/agent/src/runtime/mcp | ✅ #944 PR #963 — 런타임·배럴·SDK 의존성·테스트 전부 삭제 |
| A6 | machines daemon CLI 진입점 | packages/machines | 🔌 |
| A7 | compaction `onSummarize` | apps/openomni index.ts | 🔌 (미주입 → elision만 동작) |
| A8 | `Tool.Events.Started/Completed/TimedOut` 발행자 0 | protocol ↔ 앱 dispatch | 🔁 실행기 자동 관측으로 대체 (#797 이후 1주+ 버스 침묵) |
| ~~A9~~ | test-only exports 16개 | 전 패키지 | ✅ #944 PR #963 — 현행 baseline 0 확인; package entry export를 포함하는 Knip 센서스와 실제 synthetic package 회귀 테스트 추가 |
| A10 | `delegation_await` 툴 | apps/openomni tools | ⏳ 위임 결과 = 새 턴이면 삭제 |
| A11 | `defineTool.inputExamples` (생성 검사만, 런타임 0) · `wireProjection` (delegate 1개용 탈입구) · `safe` (category와 이중) | apps/openomni tools/core/define.ts | 🗑 KERNEL §3.4, 슬라이스 1 |
| A12 | `execution/placement/requires` 머신 축 필드 + `fs_read/fs_list/fs_stat/machines` 툴 + `run_code.machineId` | apps/openomni tools | 🗑 §3.2 판정, 슬라이스 1 (packages/machines는 유지) |
| A13 | WorkItem/Attempt 전체: `apps/openomni/src/work-item` + completion (1,061 LOC), ledger `work-item` 스토어, protocol `work-item` 스키마, `work_items`/`complete_work` 툴 | 앱·ledger·protocol | 🗑 Owner 2026-09-03 "슬롭이니까 우선 없이" — 만족 판단은 편지 읽는 모델 (KERNEL.md §10.4) |
| ~~A14~~ | 내장 memory 층 `apps/openomni/src/memory` + `memory` 툴 (#790, 266 LOC) | 앱 | ✅ #941 PR #958 — 내장 memory 층·툴·설정·스냅샷 주입 삭제; 대체 없음 |
| ~~A15~~ | ledger `artifact` 스토어 + protocol `artifact` + `write/read_artifact` 툴 (#842, 127 LOC + 스키마) | ledger·protocol·앱 | ✅ #942 PR #959 — 저장소·스키마·어댑터·툴 삭제; 모델 문은 `truncated` 표시와 원본 크기만 유지, cell 값은 원본 그대로 |
| A16 | `converse_open/close` + `lease_open` 툴, ledger `conversation`(270)·`lease`(371)·`engagement`(311, =A4) 스토어 + protocol 대응 스키마 | 앱·ledger·protocol | 🗑 세션 간 대화 = `sendMessage`+inbox (KERNEL.md §3.4) |
| A17 | ledger `worker-run`(143) + protocol worker-run, ledger `delegation` 스토어+migration 0023, protocol `delegation` (2,338 LOC 중 대부분) | ledger·protocol | 🗑 B3와 함께; 남는 것 = §10 `message` 확장 kind 스키마만 |
## B. 반대 방향·이중 구현

| # | 대상 | 문제 | 처분 |
|---|---|---|---|
| B1 | `BusPersistence` | 버스 구독 → 저널: 유실 가능, 평탄, "버스=로그" 오류 | 🔁 ledger 먼저 → 버스 |
| B2 | `worker-loop` | resident 루프와 같은 루프의 사본 | 🔁 같은 runAgent, role·카탈로그·runner만 다름 |
| B3 | delegation kernel 963 LOC / 11 모듈 | admission·settle·deadline·correlation 5중 구현 흔적 | 🔁 세션 inbox 모델 (~300 LOC) |
| B4 | 위임 deadline `setTimeout` 재장전 체인 | 재시작 시 증발 | 🔁 `alarm` 테이블 + sweep |
| B5 | policy `stableStringify` | protocol json.ts와 두 번째 캐논 문법 | 🗑 |
| B6 | 두 정책 기계 위험: 기존 콜백 미들웨어 등록(registration/dispatch) vs 커널 선언 행 | 이관 중 둘 공존 금지 | 🔁 결정됨: 기존 엔진 유지, 행 → 등록 컴파일, 콜백 직접 등록 공개 표면 삭제, transform은 이름 있는 변환기 표 참조 |
| B7 | ledger channel-grant 정규화 + channels 재정규화 | 이중 정규화 | 🔁 channels 단일 소유 |
| B8 | resident 결과 ID 사후 발급 | 크래시 흔적 0 | 🔁 turn 봉투 선발급 |
| B9 | `messages.ts` 단일 writer 주석 + blind upsert | 배포 운으로 지켜지는 불변식 | 🔁 fenced lease |
| B10 | 채널 send 실패 일괄 처리 | not-sent/ambiguous/accepted/rejected 미구분 | 🔁 4분류 |
| B11 | `bind(ports, origin)` → 배달별 카탈로그 재조립 (resident.ts:268,277) | оpencode 턴별 registry 재계산과 같은 슬롭; §3.1 세대 스냅샷과 양립 불가 | 🔁 `execute(args, ctx)` + 생성 시 포트 주입, 슬라이스 1 |
| B12 | dispatch bare 경로 (dispatch.ts:55-70) | 정의 있는 경로와 이중 | 🗑 한 경로, 슬라이스 1 |
| B13 | `/machines/<id>/<export>/` VfsRouter + `fs_read/fs_list/fs_stat` + `machines` 발견 툴 + 툴별 3층 capability 검사 | 6동사 `machineId:/path` 접두 + `parseLocus()` 하나 + codemode 객체 핸들(`listMachines/getMachine/findMachine`)로 대체(KERNEL.md §3.2.1, Owner 2026-09-03 두 문 확정) | 🔁 packages/machines fs.ts·wire는 생존, fs.write/exec 추가; export 조회 표면 없음(거절만) |
| B14 | code-mode가 apps/openomni 안에 위치(셀 런타임·kernel.py·머신 핸들이 앱 코드) | 패키지 자격 — 앱 없이도 SDK로 소비 가능해야 | 🔁 `packages/codemode`로 이관(이름 확정 2026-09-03), 포트 주입; `run_code`는 앱 어댑터 1개 |
| B15 | `packages/placement` — 모델·툴 target 선택 순수 함수를 별도 패키지로; 실제 모델 해석은 llm/agent/llm-툴 3곳에 이중 | locus는 `parseLocus`(KERNEL §3.2.1), 모델 선택은 `packages/llm` 해석 1곳 — 패키지가 소유하는 판정이 없음 | 🗑 패키지 삭제 (Owner 2026-09-03), topology/check-deps/CI matrix 행 함께 |
| B16 | `packages/telemetry` — Bus·scope·trace.ts·포트가 한 패키지; ledger 13곳이 역방향 `Bus.publish`(B1), Bus 생산 구독자 0 | 관측은 커널의 일 — 포트는 protocol, 구현(bus+scope ~100 LOC)은 agent, `trace.ts`는 행동 트리가 trace라 중복, OTel 익스포터는 앱 sink | 🗑 패키지 삭제 (Owner 2026-09-03); 순서: 포트 이관 → agent sink 구현 → 소비자 0 확인 → 삭제 |
| B17 | `approval` 툴 {request\|decide\|contact_promote\|endpoint_merge} + 시간당 pending 8 상한 | KERNEL §4 `require_approval` verdict(커널 Wait + Owner 답)의 주소록 전용 복제; `decide` 툴이 있어 Resident가 Owner 결정을 출처 없이 찍을 수 있음(harness-philosophy audit 결함) | 🗑 툴 삭제; `contact_promote`·`endpoint_merge`는 `provision` op으로, 결재는 정책 행 (Owner 2026-09-03) |
| B18 | 툴 디렉터리 `tools/{query,mutation,authority,execution}` | 효과 등급(safe 도출)이 디렉터리 축 — 어휘 축(대상)이 아니어서 같은 대상의 op가 폴더에 흩어짐 | 🔁 `tools/{fs,watch,message,provision,code}/`, category는 defineTool 필드만 (Owner 2026-09-03) |

## C. 권한이 잘못 놓인 곳

| # | 대상 | 처분 |
|---|---|---|
| ~~C1~~ | grant fail-open: 모든 surface에 owner tier `trusted_channel` 기본 (gateway.ts, index.ts) — H1 | ✅ 닫힘 #931 — `registerTrustedChannelGrant`가 explicit `defaultTier`를 요구; named surface는 선언된 tier(없으면 최저 권한 `assigned_worker`)로 마운트, owner는 loopback ws 부트스트랩 호출 지점 하나뿐 |
| C2 | 정책 등록 지점이 앱 여기저기 → 앱이 감쌀 행동을 고름 | 🔁 실행기가 4종 강제 |
| C3 | tool post 출력 검증 `z.custom<object>`로 약화 — H5 | 🔁 tool.post |
| C4 | settle 완료 권한이 코드 하드코딩(verified+zero-refuted) | 🔁 정책 행 |
| C5 | ledger가 소유한 판단: connector consent, WorkItem eligibility, blacklist 매칭 | 🔁 앱/채널로 |
| C6 | policy 엔진 안의 `Date.now`/콜백 I/O, 제품 어휘(owner tier, channel grant) | 🔁 주입 + 행 |
| C7 | 관측 identity를 발행자가 자칭 → `agentName` 오귀속 — H2 | 🔁 scoped sink, identity spread last |
| C8 | `workerRunId=delegationId` 저장 vs worker-loop가 매 run 새 runId 발급 — correlation 단절 | 🔁 B2로 소멸 |

## D. 결함

| # | 대상 | 처분 |
|---|---|---|
| D1 | `packages/machines/src/fs.ts:304-309` openRoot 재시작 분기 close→open throw 시 dirfd 이중 close | ✅ 닫힘 #932 — 단일 소유(`owned` 클리어 후 close), 주입 reopen 실패 회귀 테스트 |
| D2 | 동시 메시지 = 동시 LLM 턴 (세션 직렬화 없음) | 🔁 L1 |
| D3 | 부팅 reply-grant 재생이 route.decided 전체 스캔 O(history) | 🐛 |
| D4 | `history()` 턴마다 전체 재구성 + getParts N+1 | 🐛 |
| ~~D5~~ | llm `extractUsage` 부재/타입오류 → 0 (fail-open 계정) | ✅ 닫힘 #933 (PR #954) — KERNEL §5.3대로 provider usage + 로컬 추정 결합. `extractUsage`의 필수 input/output은 `number \| undefined`: 부재·타입오류·도메인 이탈(NaN/Infinity/음수/소수/unsafe) 전부 unusable, 보고된 숫자 `0`만 authoritative. alias 해석은 값이 아니라 **키 존재**로 결정 → 정당한 `0`도, provider가 자기모순한 필드도 하위 alias로 흘러내리지 않는다. step-finish fold가 unusable 필드만 주입형 `estimateUsage` 포트로 필드 단위 대체(기본값 = 결정적 `ceil(chars/4)`, input=직렬화 프롬프트 / output=tool-call JSON 포함 assistant 텍스트; `run()`이 `promptText`로 전달). 출력 소스는 step마다 리셋 → 다중 step 합계 가산성 유지. `InvalidUsageError`는 소비자 0 → 분류기까지 삭제(grep-zero), 잘못된 계정이 fold를 중단시키지 않는다. 필수 `?? 0` 2개 grep-zero, 추가 라인 `any`/`unknown` 0, mutation 3종 확인. 옵션 reasoning/cache 0 기본값은 유지(삭제 대상 아님) |
| ~~D6~~ | `cli/doctor.ts:77-81` — `OPENOMNI_WS_PORT` 두 번째 파서(`>=1`, 불일치 시 3000 대입) vs `config.ts:120` (0..65535 허용). 포트 0(ephemeral)이면 3000을 찔러 daemon active 시 거짓 `fail` | ✅ 닫힘 #951 (PR #953) — 파서는 `config.ts` `parseWsPort` 하나뿐(`portFromEnv` grep-zero, 타입 코드 `invalid_ws_port`); doctor는 이를 소비만 한다: 0 → `warn` 스킵(네트워크 호출 0), unset → 파서 자신의 기본값, invalid → 파서 판정으로 `fail`. `rg -n '3000' cli/doctor.ts` 0 hits |

## E. 복잡도·크기·테스트

| # | 대상 | 처분 |
|---|---|---|
| E1 | 500 LOC 초과 18 파일 (kernel.ts 974, turn.ts 868) | 🔁 이관 시 자연 분해; 기계적 분할 금지 |
| E2 | policy `mergeEntries` 복잡도 46 | 🔁 match 1단 우선순위 |
| E3 | 테스트 중복 6.29% (386 clones) | 🗑 fixture 추출, 동시-턴 의존 테스트는 D2와 함께 삭제 |
| E4 | prod `unknown` 383 (Tier-B) | ⏳ 경계 정책 필요 |
| E5 | script/ 게이트 자체 미측정 | 🔌 |
| E6 | `*ToolExecutor` 이름 잔재 (query/machine-fs.ts, machines.ts) | 🗑 A12와 함께 파일 자체 삭제 |
| E8 | 툴 28개 — 같은 endpoint·같은 visibility가 도메인별 버버 분할 (approval 4, provision 7, converse+lease 3, artifacts 2, work_items 2, llm 2) | 🔁 `op` 유니온 + WorkItem/converse/delegate/memory/artifacts/approval 툴 삭제로 11개(모델 10 + 셀 llm 1) (KERNEL.md §3.4, 2026-09-03), 슬라이스 1 |
| E7 | prose 핀 테스트 잔재(vendor 메시지 문자열) | 🗑 구조값으로 |

## F. 이슈 처분 (D4, 확정 시)

흡수(커널로): #606 #217 #807 #533 · 위생 배치: #880 #695 #614 #767 #837 · park: #808 #809 #810 #811 #457 #458 #219 #214 #463 #887 #226

### F.1 커널 캠페인 이슈화 (2026-09-03 확정)

로드맵 SSOT = **epic #930** (구 #459 대체). 자식 #931–#949 (의존성 순), park 후속 #950 (구 #811). 닫힘: #459 #217 #811 (receipt 코멘트에 후속 링크).

SLOP row → 소유 이슈 (grep-zero 병합 조건은 각 이슈 Acceptance에 있음):

| Row | Issue | | Row | Issue |
|---|---|---|---|---|
| A1,A2,A4,A5,A9,A13–A16 | #940–#945, 집계 #948 | | B8,B9,B11 | #935 |
| A3,A10,A17 | #946 | | B12 | #949 |
| A6 | #938 #939 | | B13,B14 | #938 #939 |
| A7 | #937 | | C1 | #931 #932 #933 |
| A8 | #936 | | C2,C3,C6,C7 | #936 |
| A11,A12 | #949 | | C4,C5,C8 | #946 |
| B1 | #934 | | D1,D5 | #931 #932 #933 |
| B2 | #937 | | D2,D4 | #935 |
| B3,B4,B7,B10 | #946 | | D3 | #946 |
| B5,B6 | #936 | | E1 | #937 |
| E2 | #936 | | E3,E5,E7 | #940–#945 |
| E6,E8 | #949 | | B15,B16 | #936 (telemetry) · #949 (placement) |
| B17,B18 | #949 | | D6 | #951 |
| G행 | 각 행의 이슈 열 | | | |

E4(prod `unknown` census)는 캠페인 밖 — 경계 정책이 미결이므로 어느 자식도 소유하지 않음(정책 확정 후 별도 이슈). #811 park 스코프(sandbox/egress)는 #950(icebox)으로 이관, #938/#939/#946 종료 후 재-triage.

## G. 2026-09-03 전수 스윕 (패키지별 dead / legacy / dup) — 위 A–E에 없는 신규 발견만

방법: 심볼별 `rg -n '<sym>' packages apps --glob '!*.test.ts' --glob '!**/test/**'` 로 선언 파일 밖 프로덕션 소비자 0 ⇒ dead. 각 행은 **소유 이슈**를 명시 — 그 이슈가 닫힐 때 같은 PR에서 함께 제거되며, 그 이슈 본문의 "Closes" 에 행 ID가 들어간다. 처분: 🗑 삭제 · 🔁 재배선/통합 · 🐛 수정 · 🔒 비공개화(export 제거).

### G.1 protocol

| id | 대상 | 왜 | 처분 | LOC | 이슈 |
|---|---|---|---|---:|---|
| G-P01 | `protocol/src/ledger/streams.ts:22-150` `StreamRegistry` | 런타임 할당되는 문서 객체. 실제 스트림 라이터는 별도 상수 사용. 소비자 0 | 🗑 | 130 | #944 |
| G-P02 | `ledger/streams.ts:159-160` `RouteDecided` (+ `ledger/index.ts:46-47`) | `IngressEvents.RoutingDecision.schema` 중복 alias. 테스트 1곳만 | 🗑 | 4 | #944 |
| G-P03 | `ingress/index.ts:327-352` `extractText` | 공유 파서로 승격됐지만 프로덕션 호출 0 (테스트만) | 🗑 | 26 | #944 |
| G-P04 | `token/index.ts:45-57` `ExecutionUsage` | "historical partial accounting" — 런타임 참조 0 | 🗑 | 13 | #944 |
| G-P05 | `model/index.ts:3-5` `Model.Status` (+ llm `ModelsDev.ModelStatus` 재export) | 라이브 모델 인터페이스가 의도적으로 status 생략. 소비자 0 | 🗑 | 3 | #944 |
| G-P06 | `policy/index.ts:59-70` `PolicyPlan` + `ingress/index.ts:166` `AgentDefSchema.policyPlan` | 받기만 하고 읽지 않는 설정 필드. 엔진에 전달 안 됨 | 🗑 | 13 | #936 (정책 컴파일 시 스키마 정리) |
| G-P07 | `event/policy.ts:63-71,88-94` `ActionRequested`/`ActionBlocked` | 발행자 0. 라이브 audit은 `Evaluated`/`DecisionComposed`만 | 🗑 | 16 | #936 |
| G-P08 | `event/operational.ts:50-66` `GovernorIncident` | "first producer = boot tail verification" 주석만, 생산자 0 | 🗑 | 17 | #944 |
| G-P09 | `wait/events.ts:46-61` `SyncAsk` | 옛 동기 `resident.ask` 감사 이벤트. emitter/reader 0 | 🗑 | 16 | #946 (wait 재작성) |
| G-P10 | `event/ingress.ts:70-102` pending-stack upcast (`runId`/`pendingInteractionId`/`pending_ask:`/`pending_interaction:`) | 이미 삭제된 pending 스택의 읽기 shim. 새 라이터는 이 shape 못 냄. 라이브 reader: `channels/src/router/index.ts:256`, `routing-resolution.ts:414` | 🔁 영속 팩트 backfill 마이그레이션 → shim 삭제 | 33 | #946 |
| G-P11 | `message/index.ts:51-60` `StepFinishPart.tokens` reasoning/cache 기본값 | pre-#61 파트용 읽기 호환. 현 생산자는 항상 두 레인 공급 | 🔁 rows backfill → default 제거 | 10 | #935 (parts 저장 소유) |

### G.2 ledger

| id | 대상 | 왜 | 처분 | LOC | 이슈 |
|---|---|---|---|---:|---|
| G-L1 | `ledger/src/app-connector/index.ts:120-160` `AppConnectorInstallationStore` + `storage/sqlite-app-connector-installation-adapter.ts` | 앱은 provisioning `ChannelInstanceStore` 사용. 프로덕션 소비자 0 | 🗑 (+ 테이블 drop을 I09 forward migration에 포함) | 94 | #944 |
| G-L2 | `bus-persistence/query.ts:19-49` `BusQuery.listErrors`/`verifyChainIntegrity` + `event-query.ts`, `chain-query.ts` | 테스트 전용. B1(#934) BusPersistence 삭제에 포함 — 별도 작업 없음, 명시용 | 🗑 | 105 | #934 (B1 하위) |
| G-L3 | `bus-persistence/query.ts:28-38` + `worker-run-history-query.ts` | worker-run 동결 아카이브 조회. A17과 동일 계열 | 🗑 | 55 | #946 (A17 하위) |
| G-L4 | `storage/sqlite-schema-lifecycle.ts:60-62` + `migration/0004_cron_job/migration.sql` | 어댑터 삭제 후에도 `cron_job` 테이블 create/reset 유지 | 🗑 forward migration으로 drop | 8 | #944 |

### G.3 channels · machines

| id | 대상 | 왜 | 처분 | LOC | 이슈 |
|---|---|---|---|---:|---|
| G-CH1 | `channels/src/router/routing-resolution.ts:29-32` `IngressRoutingErrorCode` 4멤버 (`dispatch_runtime_missing`/`_route_invalid`/`dispatch_failed`/`_output_unsupported`) | dispatch 실행이 빠졌는데 에러 어휘만 남음. 생성 경로 0 | 🗑 | 4 | #944 |
| G-CH2 | `router/wait/lifecycle.ts:74-76` `WaitService.cancel` | 취소 워크플로 호출자 0 (테스트 1곳) | 🗑 | 3 | #946 |
| G-CH3 | `authn/websocket.ts:55-57,88-101` query-string `?token=` 인증 fallback | subprotocol `auth,<token>` 이 정본. URL에 크리덴셜 누출 경로 + 성공 분기 2개. 프로덕션 URL 생성자 0 | 🗑 subprotocol만 허용 | 16 | #931 (권한 결함 클러스터) |
| G-CH4 | `provider/contract.ts:30-33` mode `"bridge"` | Signal/WhatsApp 가정의 투기 어휘. 4 provider 모두 poll/socket/webhook | 🗑 | 3 | #944 |
| G-CH5 | `authn/triggers.ts:53-107` provider별 트리거 wrapper 4개 | 상수만 다른 동일 매핑 4회. 모두 `evaluateChannelTriggers` 직위임 | 🔁 surface 파라미터 1진입 (정책 ID/리소스 보존) | ~30 | #946 |
| G-CH6 | `provider/{discord:199-211,slack:165-182,telegram:188-200}/surface.ts` outbound 루프 | empty-text/render/chunk/순차send/lastId 누적 3중 구현. Slack thread만 실질 차이 | 🔁 per-chunk sender 콜백 받는 루프 1개 | ~20 | #946 (B10 send 재작성) |
| G-CH7 | `provider/{discord:172,slack:154,telegram:181,github:241}/surface.ts` handler post-start fallback | start 시 handler 필수 게이트가 이미 있음(discord 84-88, slack 52-56, telegram 49, github 110). 2개는 침묵 drop, 2개는 다른 문구로 재throw | 🗑 start 게이트만 유지 | 16 | #944 |
| G-CH8 | `channels/src/index.ts:1-6,10-13,16-19,25` barrel | 어댑터/노멀라이저 6, 개별 provider 4, `IngestMode`/`ProviderCapabilities`/`ProviderRuntime`/`PublishPort` — 루트 import 0. 앱 seam은 `ChannelProviders`+`ChannelProvider` | 🗑 barrel 정리 | 14 | #944 |
| G-CH9 | `provider/*/surface.ts`, `discord/gateway.ts:22`, `slack/socket.ts:15`, `telegram/poller.ts:8` option/callback 인터페이스 7개 | 선언 파일 밖 import 0 | 🔒 | 7 | #944 |
| G-M1 | `machines/src/errors.ts:14,27` `MachineCellFailure`/`MachineDaemonProtocolFailure` (+ `index.ts:4,6`) | 클래스는 live, 인스턴스 alias는 소비자 0 | 🗑 | 4 | #938 |
| G-M2 | `machines/src/kernel.ts:124-125,135` `llm_batched` | `llm` 정확 pass-through 동의어. 프롬프트/프로덕션 참조 0 (테스트 1곳) | 🗑 | 5 | #938 |
| G-M3 | `machines/src/index.ts:8` `createFsDriver`/`FsDriver` export | 데몬 내부 구현. 루트 import 0 (`daemon.ts:36` 내부 호출만) | 🔒 | 1 | #938 |
| G-M4 | `machines/src/kernel.ts:206` `CellToolCaller` export | 테스트 주석용 export. 내부 시그니처 | 🔒 | 1 | #938 |

### G.4 apps/openomni

| id | 대상 | 왜 | 처분 | LOC | 이슈 |
|---|---|---|---|---:|---|
| G-H1 | `composition/composer.ts:29-37,66-67,171-177` `FiberSnapshot`/`snapshot()`/`effects` + stale `pending` 주석 | 테스트 전용 진단 스냅샷 | 🗑 | ~179 관여 | #944 |
| G-H2 | `composition/driver-registry.ts:27-40,50-63,104-123` generation/`inFlight()`/`drain()` | 라이프사이클이 사용 안 함 | 🗑 | ~132 관여 | #936 (driver-registry 이미 범위) |
| G-H3 | `composition/policy-registry.ts:31-39,54-61,75-77` `PolicyRegistration.name/.class`, `MissingMandatoryPolicyError` | 검사 의식(ceremony). 정책 컴파일(B5)로 레지스트리 자체 제거 | 🗑 | ~94 관여 | #936 |
| ~~G-H4~~ | `cli/doctor.ts:77-81` | = D6 | ✅ 닫힘 #951 (PR #953) | 60 | #951 |
| G-H5 | `provisioning/init.ts:7-13,18-80` env→provisioning 1회성 마이그레이션 | composition에 상주. 크리덴셜 매핑 중복 | 🗑 (1회 실행 후 제거; 필요시 CLI 서브커맨드로 격리) | 118 | #944 |
| G-H6 | `channels.ts:107-115,71-100` 트리거 정책 env-path vs declared-path 중복 ("PR-B temp" 주석) | 임시 주석이 영구화 | 🔁 declared-path 단일화 (G-CH5와 동일 PR) | 35 dup | #946 |
| G-H7 | `provisioning/declared.ts:58-70` reconcile당 `SecretStore.get` 2회 (credential + rotation meta) | 회피 가능한 이중 read | 🐛 1회 read | 5 | #949 (provision 툴) |
| G-H8 | `tools/core/catalog.ts:66-78` 중첩 Proxy 가짜 포트 | `createTools` 순회 강제용 스캐폴딩. 카탈로그를 정적 목록으로 바꾸면 소멸 | 🗑 | 14 | #949 |
| G-H9 | `tools/execution/llm.ts:56-62` 빈 doc 블록 | 고아 주석 | 🗑 | 7 | #949 |

### G.5 agent · llm · policy

| id | 대상 | 왜 | 처분 | LOC | 이슈 |
|---|---|---|---|---:|---|
| G-AG1 | `agent/src/core/budget.ts:120` `checkBudget` (+ `index.ts:12`) | 프로덕션 호출 0 (테스트만) | 🗑 | 10 | #937 |
| G-AG2 | `agent/src/index.ts:29` `isTimeCarriageMarkerPart`/`CompactionGeometry`/`SummarizationBudget` 공개 export | 패키지 밖 import 0 — 내부 전용 | 🔒 | 7 | #937 |
| G-AG3 | `agent/src/index.ts:27` `placementGatedExecutor` export | `turn.ts:232` 내부 호출만. 외부 import 0 — placement 삭제(B15)와 함께 소멸 | 🔒→🗑 | 2 | #949 |
| G-LLM1 | `llm/src/run.ts:116` `LegacyError` outcome arm | `run()`은 `Run.FailureError`만 생성(`run.ts:418`). 생산자가 낼 수 없는 호환 shape | 🗑 outcome을 `FailureError`로 축소 | 7 | #937 |
| G-LLM2 | `llm/src/run.ts:122` `Run.Outcome` 런타임 zod 스키마 | `.parse/.safeParse` 호출 0 — 타입으로만 사용 | 🔁 정적 union 타입으로 | 14 | #937 |
| G-LLM3 | `llm/src/run.ts:77` `RunDependencies` export | 같은 파일 사용만, 배럴 재export 없음 | 🔒 | 1 | #937 |
| G-POL1 | `policy/src/engine/registration-validation.ts:22,267-275` `legacy_timing_registration` 분류 + `hasCanonicalFields` | canonical 필드 없는 legacy 등록용 핫패스 분기 — 그런 등록 프로덕션 0 | 🗑 (`invalid_canonical_registration`으로 실패) | 8 | #936 |
| G-POL2 | `policy/src/index.ts:3` `PolicyRegistrationError` 재export 2단 | 패키지 밖 import/catch 0 | 🔒 | 2 | #936 |
| G-POL3 | `policy/src/engine/types.ts:45` `PolicyDecision` alias | 내부는 `Policy.PolicyDecision` 직접 사용, 외부 import 0 | 🗑 | 2 | #936 |

### G.6 요약

- 신규 dead/legacy ≈ **1,050 LOC** (관여 LOC 기준; 순삭제 ≈ 650) + 기존 A–E 위에 추가. 총 46행.
- 소유 분포: #944 (dormant 삭제) 15행 · #946 7행 · #936 7행 · #937 5행 · #949 4행 · #938 4행 · #931 1행 · #934/#935/#951 각 1행. 각 소유 이슈에 행 목록 코멘트 게시 완료(2026-09-03).
- #944 제목/범위를 "agent,channels,ledger" → "protocol,ledger,channels,openomni composition" 으로 확장 (이슈 코멘트로 반영).
- 보안 성격 1건: G-CH3 (URL 토큰 인증 fallback) — M0 #931 에서 처리.
