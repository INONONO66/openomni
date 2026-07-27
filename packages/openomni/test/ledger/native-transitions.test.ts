import { describe, expect, test } from "bun:test";
import { Ledger as ProtocolLedger } from "../../../protocol/src/ledger/index.js";
import { Execution } from "../../../protocol/src/execution/index.js";
import {
  CLOSED_OPERATION_CATALOG_V1,
  CONFIGURATION_OPERATION_CATALOG_V1,
  CONFIGURATION_OPERATION_FAMILY_CARDINALITIES,
} from "../../src/ledger/native-transitions.js";

import {
  NATIVE_TRANSITION_CATALOG_R9,
  NATIVE_TRANSITION_CATALOG_VERSION,
  NATIVE_TRANSITION_FAMILY_CARDINALITIES,
  nativeTransitionById,
  validateNativeTransitionCatalog,
  type NativeTransitionCatalogRowV1,
} from "../../src/ledger/index.js";

const cloneRows = (): NativeTransitionCatalogRowV1[] =>
  structuredClone(NATIVE_TRANSITION_CATALOG_R9) as NativeTransitionCatalogRowV1[];

const emissionSignature = (row: NativeTransitionCatalogRowV1): string => {
  if (row.emission.kind === "batch") return `batch:${row.emission.eventTypes.join(",")}`;
  if (row.emission.kind === "conditional-batch") {
    return [
      `conditional-batch:source-run=${row.emission.sourceRunEventTypes.join(",")}`,
      `source-non-run=${row.emission.sourceNonRunEventTypes.join(",")}`,
    ].join(";");
  }
  if (row.emission.kind === "no-commit") return `no-commit:${row.emission.reason}`;
  return `cross-owner:${row.emission.sourceEventTypes.join(",")}>${row.emission.destinationEventTypes.join(",")}>${row.emission.settlementEventTypes.join(",")}`;
};

const fullRowSignature = (row: NativeTransitionCatalogRowV1): string => JSON.stringify(row);

// Independently reviewed, one-time golden literals. These are deliberately not derived from
// NATIVE_TRANSITION_CATALOG_R9 at test runtime; every public row field is serialized in order.
const EXPECTED_FULL_ROW_SERIALIZATIONS = [
  '{"id":"SS-01","command":"messaging.session.open.v1","emission":{"kind":"batch","eventTypes":["session.opened.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["genesis head"],"readAssertions":["session-open semantic request id is unused or receipt-identical"],"reducerIds":["session-reducer-v1"],"projectionIds":["session_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Session.create","busObservation":"post-commit-lossy","testReceiptId":"TC-SS-01"}',
  '{"id":"SS-02","command":"messaging.session.open_child.v1","emission":{"kind":"batch","eventTypes":["session.opened.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["child genesis head","foreign parent head exact"],"readAssertions":["native parent-open event ref exists and matches parent head"],"reducerIds":["session-reducer-v1"],"projectionIds":["session_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Session.createChild","busObservation":"post-commit-lossy","testReceiptId":"TC-SS-02"}',
  '{"id":"SS-03","command":"messaging.session.revise_metadata.v1","emission":{"kind":"batch","eventTypes":["session.metadata_revised.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["exact metadata revision","patch keys limited to title/model/workerMeta"],"reducerIds":["session-reducer-v1"],"projectionIds":["session_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Session.update","busObservation":"post-commit-lossy","testReceiptId":"TC-SS-03"}',
  '{"id":"SS-04","command":"messaging.session.close.v1","emission":{"kind":"batch","eventTypes":["session.closed.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["session is open"],"reducerIds":["session-reducer-v1"],"projectionIds":["session_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Session.remove","busObservation":"post-commit-lossy","testReceiptId":"TC-SS-04"}',
  '{"id":"SS-05","command":"messaging.session.expire.v1","emission":{"kind":"batch","eventTypes":["session.expired.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["database time is strictly greater than expiresAt"],"reducerIds":["session-reducer-v1"],"projectionIds":["session_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"session expiry scan","busObservation":"post-commit-lossy","testReceiptId":"TC-SS-05"}',
  '{"id":"SF-01","command":"messaging.surface.bind.v1","emission":{"kind":"batch","eventTypes":["session.opened.v1","surface.bound.v1"]},"ownerDerivation":"surface-session-owner","expectedHeadAssertions":["target session genesis or exact head","binding version 0/unbound"],"readAssertions":["canonical surface semantic key is unbound"],"reducerIds":["session-reducer-v1","surface-binding-reducer-v1"],"projectionIds":["session_projection","surface_binding_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"SurfaceKey.register","busObservation":"post-commit-lossy","testReceiptId":"TC-SF-01"}',
  '{"id":"SF-02","command":"messaging.surface.rebind.v1","emission":{"kind":"batch","eventTypes":["surface.rebound.v1"]},"ownerDerivation":"surface-session-owner","expectedHeadAssertions":["target session head exact"],"readAssertions":["current session and binding version exact"],"reducerIds":["surface-binding-reducer-v1"],"projectionIds":["surface_binding_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"SurfaceKey.rebind","busObservation":"post-commit-lossy","testReceiptId":"TC-SF-02"}',
  '{"id":"SF-03","command":"messaging.surface.unbind.v1","emission":{"kind":"batch","eventTypes":["surface.unbound.v1"]},"ownerDerivation":"surface-session-owner","expectedHeadAssertions":["current session head exact"],"readAssertions":["current binding exact; absent is receipt-idempotent"],"reducerIds":["surface-binding-reducer-v1"],"projectionIds":["surface_binding_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"SurfaceKey.remove","busObservation":"post-commit-lossy","testReceiptId":"TC-SF-03"}',
  '{"id":"MS-01","command":"messaging.message.record_inbound.v1","emission":{"kind":"batch","eventTypes":["kernel.route.decided.v1","message.inbound_recorded.v1","message.part_appended.v1","message.status_changed.v1","effect.intent.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["transport request dedupe exact","authority source refs at exact projection sequence","surface binding rechecked"],"reducerIds":["route-reducer-v1","message-reducer-v1","part-reducer-v1","effect-reducer-v1"],"projectionIds":["message_projection","part_projection","effect_projection"],"effect":{"class":"external","driverId":"resident.run.v1","reconcilerId":"resident.run.v1.reconciler.v1"},"callerReplacement":"IngressEventProjector and Resident ingress","busObservation":"post-commit-lossy","testReceiptId":"TC-MS-01"}',
  '{"id":"MS-02","command":"messaging.message.start_assistant.v1","emission":{"kind":"batch","eventTypes":["message.assistant_started.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["authenticated session/run/attempt binding","parent message exists"],"reducerIds":["message-reducer-v1"],"projectionIds":["message_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"assistant message creation","busObservation":"post-commit-lossy","testReceiptId":"TC-MS-02"}',
  '{"id":"MS-03","command":"messaging.message.append_part.v1","emission":{"kind":"batch","eventTypes":["message.part_appended.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["message is open","part ordinal is contiguous","part id/type is immutable"],"reducerIds":["part-reducer-v1"],"projectionIds":["part_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Message.addPart","busObservation":"post-commit-lossy","testReceiptId":"TC-MS-03"}',
  '{"id":"MS-04","command":"messaging.message.revise_part.v1","emission":{"kind":"batch","eventTypes":["message.part_revised.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["exact prior part revision","kind-specific revision edge is legal"],"reducerIds":["part-reducer-v1"],"projectionIds":["part_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Message.updatePart","busObservation":"post-commit-lossy","testReceiptId":"TC-MS-04"}',
  '{"id":"MS-05","command":"messaging.message.change_status.v1","emission":{"kind":"batch","eventTypes":["message.status_changed.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["status edge is monotonic","no part follows terminal status"],"reducerIds":["message-reducer-v1"],"projectionIds":["message_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Message.update status","busObservation":"post-commit-lossy","testReceiptId":"TC-MS-05"}',
  '{"id":"MS-06","command":"messaging.message.finish_assistant.v1","emission":{"kind":"batch","eventTypes":["message.assistant_started.v1","message.part_appended.v1","message.part_revised.v1","message.status_changed.v1","message.status_changed.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["ordered part revisions exact","all referenced tool/effect outcomes terminal","parent inbound is nonterminal"],"reducerIds":["message-reducer-v1","part-reducer-v1"],"projectionIds":["message_projection","part_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"resident/worker writeback","busObservation":"post-commit-lossy","testReceiptId":"TC-MS-06"}',
  '{"id":"MS-07","command":"messaging.message.recover.v1","emission":{"kind":"batch","eventTypes":["message.status_changed.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["original message ids retained","only legal continuation or terminal edge","no raw channel replay"],"reducerIds":["message-reducer-v1"],"projectionIds":["message_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"server message recovery","busObservation":"post-commit-lossy","testReceiptId":"TC-MS-07"}',
  '{"id":"RT-01","command":"kernel.route.blacklist_deny.v1","emission":{"kind":"batch","eventTypes":["kernel.route.decided.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["absolute blacklist source ref exact"],"reducerIds":["route-reducer-v1"],"projectionIds":[],"effect":{"class":"none","driverId":null,"reconcilerId":null},"callerReplacement":"ingress blacklist branch","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-01"}',
  '{"id":"RT-02","command":"kernel.route.stage_wait_ambiguity.v1","emission":{"kind":"batch","eventTypes":["kernel.route.decided.v1","wait.ambiguity_recorded.v1"]},"ownerDerivation":"surface-session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["candidate ids sorted","cross-owner candidates are not guessed"],"reducerIds":["route-reducer-v1","wait-reducer-v1"],"projectionIds":["wait_projection"],"effect":{"class":"resumable-internal","driverId":"wait.disambiguate.v1","reconcilerId":"wait.disambiguate.v1.reconciler.v1"},"callerReplacement":"PendingAsk/PendingInteraction ambiguous route","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-02"}',
  '{"id":"RT-03","command":"kernel.route.accept_report_result.v1","emission":{"kind":"cross-owner","sourceEventTypes":["kernel.route.decided.v1","wait.response_recorded.v1","wait.resolved.v1","dispatch.pending.v1"],"destinationEventTypes":["dispatch.received.v1","attempt.succeeded.v1","completion.candidate.submitted.v1"],"settlementEventTypes":["dispatch.delivered.v1"]},"ownerDerivation":"source-and-destination-owners","expectedHeadAssertions":["Wait source and work destination heads exact"],"readAssertions":["sender/correlation/action exact","threshold cardinality evaluated after unique response","exactly one delivery"],"reducerIds":["route-reducer-v1","wait-reducer-v1","dispatch-reducer-v1","attempt-reducer-v1","completion-reducer-v1"],"projectionIds":["wait_projection","dispatch_projection","attempt_projection","completion_projection"],"effect":{"class":"resumable-internal","driverId":"wait.delivery.v1","reconcilerId":"wait.delivery.v1.reconciler.v1"},"callerReplacement":"PendingInteraction report_result","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-03"}',
  '{"id":"RT-04","command":"kernel.route.accept_clarification.v1","emission":{"kind":"cross-owner","sourceEventTypes":["kernel.route.decided.v1","wait.response_recorded.v1","wait.resolved.v1","dispatch.pending.v1"],"destinationEventTypes":["dispatch.received.v1","effect.intent.v1"],"settlementEventTypes":["dispatch.delivered.v1"]},"ownerDerivation":"source-and-destination-owners","expectedHeadAssertions":["Wait source and Resident destination heads exact"],"readAssertions":["sender/correlation/action exact","threshold cardinality evaluated after unique response","exactly one delivery"],"reducerIds":["route-reducer-v1","wait-reducer-v1","dispatch-reducer-v1","effect-reducer-v1"],"projectionIds":["wait_projection","dispatch_projection","effect_projection"],"effect":{"class":"external","driverId":"resident.run.v1","reconcilerId":"resident.run.v1.reconciler.v1"},"callerReplacement":"PendingInteraction ask_clarification","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-04"}',
  '{"id":"RT-05","command":"kernel.route.accept_wait_response.v1","emission":{"kind":"batch","eventTypes":["kernel.route.decided.v1","wait.response_recorded.v1","wait.resolved.v1","effect.intent.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["transport id/hash dedupe","first threshold only","same-owner delivery intent exactly once"],"reducerIds":["route-reducer-v1","wait-reducer-v1","effect-reducer-v1"],"projectionIds":["wait_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"wait.delivery.v1","reconcilerId":"wait.delivery.v1.reconciler.v1"},"callerReplacement":"PendingAsk response correlation","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-05"}',
  '{"id":"RT-06","command":"kernel.route.unsupported_action.v1","emission":{"kind":"batch","eventTypes":["kernel.route.decided.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["unsupported_action fail-closed fact exact"],"reducerIds":["route-reducer-v1"],"projectionIds":[],"effect":{"class":"none","driverId":null,"reconcilerId":null},"callerReplacement":"ingress unsupported_action branch","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-06"}',
  '{"id":"RT-07","command":"kernel.route.missing_system_identity.v1","emission":{"kind":"batch","eventTypes":["kernel.route.decided.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["missing_system_identity fail-closed fact exact"],"reducerIds":["route-reducer-v1"],"projectionIds":[],"effect":{"class":"none","driverId":null,"reconcilerId":null},"callerReplacement":"ingress missing_system_identity branch","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-07"}',
  '{"id":"RT-08","command":"kernel.route.missing_channel_grant.v1","emission":{"kind":"batch","eventTypes":["kernel.route.decided.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["missing_channel_grant fail-closed fact exact"],"reducerIds":["route-reducer-v1"],"projectionIds":[],"effect":{"class":"none","driverId":null,"reconcilerId":null},"callerReplacement":"ingress missing_channel_grant branch","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-08"}',
  '{"id":"RT-09","command":"kernel.route.missing_actor.v1","emission":{"kind":"batch","eventTypes":["kernel.route.decided.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["missing_actor fail-closed fact exact"],"reducerIds":["route-reducer-v1"],"projectionIds":[],"effect":{"class":"none","driverId":null,"reconcilerId":null},"callerReplacement":"ingress missing_actor branch","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-09"}',
  '{"id":"RT-10","command":"kernel.route.missing_default_authority.v1","emission":{"kind":"batch","eventTypes":["kernel.route.decided.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["missing_default_authority fail-closed fact exact"],"reducerIds":["route-reducer-v1"],"projectionIds":[],"effect":{"class":"none","driverId":null,"reconcilerId":null},"callerReplacement":"ingress missing_default_authority branch","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-10"}',
  '{"id":"RT-11","command":"kernel.route.existing_resident.v1","emission":{"kind":"batch","eventTypes":["kernel.route.decided.v1","message.inbound_recorded.v1","message.part_appended.v1","message.status_changed.v1","effect.intent.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["transport dedupe","authority source refs at exact projection sequence","surface binding rechecked"],"reducerIds":["route-reducer-v1","message-reducer-v1","part-reducer-v1","effect-reducer-v1"],"projectionIds":["message_projection","part_projection","effect_projection"],"effect":{"class":"external","driverId":"resident.run.v1","reconcilerId":"resident.run.v1.reconciler.v1"},"callerReplacement":"existing Resident ingress","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-11"}',
  '{"id":"RT-12","command":"kernel.route.new_resident.v1","emission":{"kind":"batch","eventTypes":["session.opened.v1","surface.bound.v1","kernel.route.decided.v1","message.inbound_recorded.v1","message.part_appended.v1","message.status_changed.v1","effect.intent.v1"]},"ownerDerivation":"surface-session-owner","expectedHeadAssertions":["new session genesis","binding v0/unbound"],"readAssertions":["deterministic ids","binding assertion","transport dedupe"],"reducerIds":["session-reducer-v1","surface-binding-reducer-v1","route-reducer-v1","message-reducer-v1","part-reducer-v1","effect-reducer-v1"],"projectionIds":["session_projection","surface_binding_projection","message_projection","part_projection","effect_projection"],"effect":{"class":"external","driverId":"resident.run.v1","reconcilerId":"resident.run.v1.reconciler.v1"},"callerReplacement":"new Resident ingress","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-12"}',
  '{"id":"RT-13","command":"kernel.route.active_worker.v1","emission":{"kind":"cross-owner","sourceEventTypes":["kernel.route.decided.v1","message.inbound_recorded.v1","message.part_appended.v1","message.status_changed.v1","dispatch.pending.v1"],"destinationEventTypes":["dispatch.received.v1","effect.intent.v1"],"settlementEventTypes":["dispatch.delivered.v1"]},"ownerDerivation":"source-and-destination-owners","expectedHeadAssertions":["session source and Attempt destination heads exact"],"readAssertions":["attempt active","stable delivery id"],"reducerIds":["route-reducer-v1","message-reducer-v1","part-reducer-v1","dispatch-reducer-v1","effect-reducer-v1"],"projectionIds":["message_projection","part_projection","dispatch_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"coordinator.message.v1","reconcilerId":"coordinator.message.v1.reconciler.v1"},"callerReplacement":"active Worker ingress","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-13"}',
  '{"id":"RT-14","command":"kernel.route.new_foreground_worker.v1","emission":{"kind":"cross-owner","sourceEventTypes":["kernel.route.decided.v1","message.inbound_recorded.v1","message.part_appended.v1","message.status_changed.v1","dispatch.pending.v1"],"destinationEventTypes":["dispatch.received.v1","work.created.v1","attempt.allocated.v1","effect.intent.v1"],"settlementEventTypes":["dispatch.delivered.v1"]},"ownerDerivation":"source-and-destination-owners","expectedHeadAssertions":["session source and work destination heads exact"],"readAssertions":["Resident authority","deterministic work/attempt ids"],"reducerIds":["route-reducer-v1","message-reducer-v1","part-reducer-v1","dispatch-reducer-v1","work-reducer-v1","attempt-reducer-v1","effect-reducer-v1"],"projectionIds":["message_projection","part_projection","dispatch_projection","work_projection","attempt_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"coordinator.spawn.v1","reconcilerId":"coordinator.spawn.v1.reconciler.v1"},"callerReplacement":"new foreground_worker ingress","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-14"}',
  '{"id":"RT-15","command":"kernel.route.new_background_worker.v1","emission":{"kind":"cross-owner","sourceEventTypes":["kernel.route.decided.v1","message.inbound_recorded.v1","message.part_appended.v1","message.status_changed.v1","dispatch.pending.v1"],"destinationEventTypes":["dispatch.received.v1","work.created.v1","attempt.allocated.v1","effect.intent.v1"],"settlementEventTypes":["dispatch.delivered.v1"]},"ownerDerivation":"source-and-destination-owners","expectedHeadAssertions":["session source and work destination heads exact"],"readAssertions":["Resident authority","deterministic work/attempt ids","background returns only after source commit"],"reducerIds":["route-reducer-v1","message-reducer-v1","part-reducer-v1","dispatch-reducer-v1","work-reducer-v1","attempt-reducer-v1","effect-reducer-v1"],"projectionIds":["message_projection","part_projection","dispatch_projection","work_projection","attempt_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"coordinator.spawn.v1","reconcilerId":"coordinator.spawn.v1.reconciler.v1"},"callerReplacement":"new background_worker ingress","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-15"}',
  '{"id":"RT-16","command":"kernel.route.stop_or_cancel.v1","emission":{"kind":"cross-owner","sourceEventTypes":["kernel.route.decided.v1","dispatch.pending.v1"],"destinationEventTypes":["dispatch.received.v1","dispatch.decision.v1","effect.intent.v1"],"settlementEventTypes":["dispatch.delivered.v1"]},"ownerDerivation":"source-and-destination-owners","expectedHeadAssertions":["source and each destination head exact"],"readAssertions":["pending records sorted","no direct attempt mutation"],"reducerIds":["route-reducer-v1","dispatch-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"coordinator.cancel.v1","reconcilerId":"coordinator.cancel.v1.reconciler.v1"},"callerReplacement":"ingress stop/cancel handler","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-16"}',
  '{"id":"RT-17","command":"kernel.route.schedule_fire.v1","emission":{"kind":"cross-owner","sourceEventTypes":["schedule.fire_due.v1","dispatch.pending.v1"],"destinationEventTypes":["dispatch.received.v1","kernel.route.decided.v1","effect.intent.v1"],"settlementEventTypes":["dispatch.delivered.v1"]},"ownerDerivation":"source-and-destination-owners","expectedHeadAssertions":["schedule source and route destination heads exact"],"readAssertions":["due generation CAS","database time at or after nextFireAt","transient outcome remains pending"],"reducerIds":["schedule-reducer-v1","dispatch-reducer-v1","route-reducer-v1","effect-reducer-v1"],"projectionIds":["schedule_projection","dispatch_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"schedule.delivery.v1","reconcilerId":"schedule.delivery.v1.reconciler.v1"},"callerReplacement":"CronJobRunner direct ingress","busObservation":"post-commit-lossy","testReceiptId":"TC-RT-17"}',
  '{"id":"DP-01","command":"kernel.dispatch.deny.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["authority source refs exact","handler not invoked"],"reducerIds":["dispatch-reducer-v1"],"projectionIds":["dispatch_projection"],"effect":{"class":"none","driverId":null,"reconcilerId":null},"callerReplacement":"DispatchRuntime deny","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-01"}',
  '{"id":"DP-02","command":"kernel.dispatch.pending.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["authority source refs exact","handler not invoked while pending"],"reducerIds":["dispatch-reducer-v1"],"projectionIds":["dispatch_projection"],"effect":{"class":"none","driverId":null,"reconcilerId":null},"callerReplacement":"DispatchRuntime pending","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-02"}',
  '{"id":"DP-03","command":"kernel.dispatch.unsupported_actor_message.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["unsupported action exact","no semantic reuse"],"reducerIds":["dispatch-reducer-v1"],"projectionIds":["dispatch_projection"],"effect":{"class":"none","driverId":null,"reconcilerId":null},"callerReplacement":"DispatchRuntime unsupported_actor_message","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-03"}',
  '{"id":"DP-04","command":"kernel.dispatch.unknown_action.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["unsupported action exact","no semantic reuse"],"reducerIds":["dispatch-reducer-v1"],"projectionIds":["dispatch_projection"],"effect":{"class":"none","driverId":null,"reconcilerId":null},"callerReplacement":"DispatchRuntime unknown_action","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-04"}',
  '{"id":"DP-05","command":"kernel.dispatch.spawn_worker.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","work.created.v1","attempt.allocated.v1","effect.intent.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["work genesis head"],"readAssertions":["Resident-only authority","criteria and policy frozen"],"reducerIds":["dispatch-reducer-v1","work-reducer-v1","attempt-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","work_projection","attempt_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"coordinator.spawn.v1","reconcilerId":"coordinator.spawn.v1.reconciler.v1"},"callerReplacement":"worker.spawn handler","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-05"}',
  '{"id":"DP-06","command":"kernel.dispatch.connector_submit.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","effect.intent.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["installation enabled/consented","installation version/source ref exact"],"reducerIds":["dispatch-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","effect_projection"],"effect":{"class":"external","driverId":"connector.submit.v1","reconcilerId":"connector.submit.v1.reconciler.v1"},"callerReplacement":"connector submit handler","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-06"}',
  '{"id":"DP-07","command":"kernel.dispatch.submit_completion.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","attempt.succeeded.v1","completion.candidate.submitted.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["immutable exact claims","current criteria revision","candidate stakes snapshot exact"],"reducerIds":["dispatch-reducer-v1","attempt-reducer-v1","completion-reducer-v1"],"projectionIds":["dispatch_projection","attempt_projection","completion_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"worker.complete","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-07"}',
  '{"id":"DP-08","command":"kernel.dispatch.submit_completion_readback.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","attempt.succeeded.v1","completion.candidate.submitted.v1","completion.readback_requested.v1","effect.intent.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["immutable exact claims","GET/HEAD request frozen","verifier and stakes refs frozen"],"reducerIds":["dispatch-reducer-v1","attempt-reducer-v1","completion-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","attempt_projection","completion_projection","effect_projection"],"effect":{"class":"external","driverId":"completion.readback.v1","reconcilerId":"completion.readback.v1.reconciler.v1"},"callerReplacement":"worker completion readback","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-08"}',
  '{"id":"DP-09","command":"kernel.dispatch.cancel_work.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","work.cancelled.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["terminal CAS","terminal repeat receipt-idempotent"],"reducerIds":["dispatch-reducer-v1","work-reducer-v1"],"projectionIds":["dispatch_projection","work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"dispatch cancel_work","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-09"}',
  '{"id":"DP-10","command":"kernel.dispatch.fail_work.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","work.failed.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["terminal CAS","terminal repeat receipt-idempotent"],"reducerIds":["dispatch-reducer-v1","work-reducer-v1"],"projectionIds":["dispatch_projection","work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"dispatch fail_work","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-10"}',
  '{"id":"DP-11","command":"kernel.dispatch.interrupt_attempt.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","attempt.interrupted.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["terminal CAS","terminal repeat receipt-idempotent"],"reducerIds":["dispatch-reducer-v1","attempt-reducer-v1"],"projectionIds":["dispatch_projection","attempt_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"dispatch interrupt_attempt","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-11"}',
  '{"id":"DP-12","command":"kernel.dispatch.message_worker.v1","emission":{"kind":"cross-owner","sourceEventTypes":["dispatch.decision.v1","dispatch.pending.v1"],"destinationEventTypes":["dispatch.received.v1","effect.intent.v1"],"settlementEventTypes":["dispatch.delivered.v1"]},"ownerDerivation":"source-and-destination-owners","expectedHeadAssertions":["source and target heads exact"],"readAssertions":["target active","grant and policy refs exact"],"reducerIds":["dispatch-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"coordinator.message.v1","reconcilerId":"coordinator.message.v1.reconciler.v1"},"callerReplacement":"worker.send","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-12"}',
  '{"id":"DP-13","command":"kernel.dispatch.resume_wait.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","wait.resume_requested.v1","effect.intent.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["Wait resolved","stable delivery id"],"reducerIds":["dispatch-reducer-v1","wait-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","wait_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"coordinator.message.v1","reconcilerId":"coordinator.message.v1.reconciler.v1"},"callerReplacement":"worker.resume","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-13"}',
  '{"id":"DP-14","command":"kernel.dispatch.ensure_cancel.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","effect.intent.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["active attempt or terminal idempotent result"],"reducerIds":["dispatch-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"coordinator.cancel.v1","reconcilerId":"coordinator.cancel.v1.reconciler.v1"},"callerReplacement":"worker.cancel","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-14"}',
  '{"id":"DP-15","command":"kernel.dispatch.ask_resident.v1","emission":{"kind":"conditional-batch","sourceRunEventTypes":["wait.opened.v1","dispatch.pending.v1","attempt.waiting.v1"],"sourceNonRunEventTypes":["wait.opened.v1","dispatch.pending.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["source-run opens Wait and dispatch pending before atomic attempt suspension","source-non-run opens Wait and dispatch pending without attempt suspension"],"reducerIds":["wait-reducer-v1","dispatch-reducer-v1","attempt-reducer-v1"],"projectionIds":["wait_projection","dispatch_projection","attempt_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"resident.ask/PendingAsk","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-15"}',
  '{"id":"DP-16","command":"kernel.dispatch.accept_response.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","wait.response_recorded.v1","wait.resolved.v1","effect.intent.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["unique response map cardinality","delivery only at first threshold","C0-C5 crash receipt"],"reducerIds":["dispatch-reducer-v1","wait-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","wait_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"wait.delivery.v1","reconcilerId":"wait.delivery.v1.reconciler.v1"},"callerReplacement":"PendingAsk/PendingInteraction response selector","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-16"}',
  '{"id":"DP-17","command":"kernel.dispatch.actor_fire_and_forget.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","effect.intent.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["source and any destination heads exact"],"readAssertions":["existing actor target","zero WorkItem/Attempt allocation"],"reducerIds":["dispatch-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","effect_projection"],"effect":{"class":"external","driverId":"actor.delivery.v1","reconcilerId":"actor.delivery.v1.reconciler.v1"},"callerReplacement":"dispatch actor_fire_and_forget","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-17"}',
  '{"id":"DP-18","command":"kernel.dispatch.actor_awaited.v1","emission":{"kind":"cross-owner","sourceEventTypes":["dispatch.decision.v1","wait.opened.v1","dispatch.pending.v1"],"destinationEventTypes":["dispatch.received.v1","effect.intent.v1"],"settlementEventTypes":["dispatch.delivered.v1"]},"ownerDerivation":"source-and-destination-owners","expectedHeadAssertions":["source and any destination heads exact"],"readAssertions":["existing actor target","zero WorkItem/Attempt allocation"],"reducerIds":["dispatch-reducer-v1","wait-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","wait_projection","effect_projection"],"effect":{"class":"external","driverId":"actor.delivery.v1","reconcilerId":"actor.delivery.v1.reconciler.v1"},"callerReplacement":"dispatch actor_awaited","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-18"}',
  '{"id":"DP-19","command":"kernel.dispatch.external_submit.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","effect.intent.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["endpoint exact","driver/reconciler version registered"],"reducerIds":["dispatch-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","effect_projection"],"effect":{"class":"external","driverId":"external.submit.v1","reconcilerId":"external.submit.v1.reconciler.v1"},"callerReplacement":"dispatch external_submit","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-19"}',
  '{"id":"DP-20","command":"kernel.dispatch.a2a_submit.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","effect.intent.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["endpoint exact","driver/reconciler version registered"],"reducerIds":["dispatch-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","effect_projection"],"effect":{"class":"external","driverId":"a2a.submit.v1","reconcilerId":"a2a.submit.v1.reconciler.v1"},"callerReplacement":"dispatch a2a_submit","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-20"}',
  '{"id":"DP-21","command":"kernel.dispatch.api_submit.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","effect.intent.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["endpoint exact","driver/reconciler version registered"],"reducerIds":["dispatch-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","effect_projection"],"effect":{"class":"external","driverId":"api.submit.v1","reconcilerId":"api.submit.v1.reconciler.v1"},"callerReplacement":"dispatch api_submit","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-21"}',
  '{"id":"DP-22","command":"kernel.dispatch.device_submit.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","effect.intent.v1"]},"ownerDerivation":"session-owner","expectedHeadAssertions":["expected session owner head"],"readAssertions":["system target exact","risk and device resolver exact"],"reducerIds":["dispatch-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","effect_projection"],"effect":{"class":"external","driverId":"device.submit.v1","reconcilerId":"device.submit.v1.reconciler.v1"},"callerReplacement":"device dispatch handler","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-22"}',
  '{"id":"DP-23","command":"kernel.dispatch.schedule_create.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","schedule.created.v1","schedule.advanced.v1"]},"ownerDerivation":"schedule-owner","expectedHeadAssertions":["schedule genesis head"],"readAssertions":["schedule version 1","next UTC fire deterministic"],"reducerIds":["dispatch-reducer-v1","schedule-reducer-v1"],"projectionIds":["dispatch_projection","schedule_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"schedule.create","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-23"}',
  '{"id":"DP-24","command":"kernel.dispatch.schedule_cancel.v1","emission":{"kind":"batch","eventTypes":["dispatch.decision.v1","schedule.cancelled.v1"]},"ownerDerivation":"schedule-owner","expectedHeadAssertions":["schedule head exact"],"readAssertions":["schedule version exact"],"reducerIds":["dispatch-reducer-v1","schedule-reducer-v1"],"projectionIds":["dispatch_projection","schedule_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"schedule.cancel","busObservation":"post-commit-lossy","testReceiptId":"TC-DP-24"}',
  '{"id":"WI-01","command":"kernel.work.create.v1","emission":{"kind":"batch","eventTypes":["work.created.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["work genesis head"],"readAssertions":["nonempty criteria","immutable source/session/origin/executor/retry/dependencies","work genesis; parent proof/head when present"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore create","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-01"}',
  '{"id":"WI-02","command":"kernel.work.revise_metadata.v1","emission":{"kind":"batch","eventTypes":["work.metadata_revised.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["patch keys exactly name/intent/goal/context/constraints/changedFiles"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore revise_metadata","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-02"}',
  '{"id":"WI-03","command":"kernel.work.revise_criteria.v1","emission":{"kind":"batch","eventTypes":["work.criteria_revised.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["criteria revision exact"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore revise_criteria","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-03"}',
  '{"id":"WI-04","command":"kernel.work.replace_dependencies.v1","emission":{"kind":"batch","eventTypes":["work.dependencies_replaced.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["one projection checkpoint exact"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore replace_dependencies","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-04"}',
  '{"id":"WI-05","command":"kernel.work.start.v1","emission":{"kind":"batch","eventTypes":["work.started.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["allocated attempt exists"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore start","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-05"}',
  '{"id":"WI-06","command":"kernel.work.record_evidence.v1","emission":{"kind":"batch","eventTypes":["work.evidence_recorded.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["immutable evidence id/hash"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore record_evidence","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-06"}',
  '{"id":"WI-07","command":"kernel.work.record_readback.v1","emission":{"kind":"batch","eventTypes":["work.readback_evidence_recorded.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["immutable readback and effect ref"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore record_readback","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-07"}',
  '{"id":"WI-08","command":"kernel.work.add_blocker.v1","emission":{"kind":"batch","eventTypes":["work.blocker_added.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["unique active blocker"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore add_blocker","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-08"}',
  '{"id":"WI-09","command":"kernel.work.resolve_blocker.v1","emission":{"kind":"batch","eventTypes":["work.blocker_resolved.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["active blocker exact"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore resolve_blocker","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-09"}',
  '{"id":"WI-10","command":"kernel.work.fail.v1","emission":{"kind":"batch","eventTypes":["work.failed.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["nonterminal work"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore fail","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-10"}',
  '{"id":"WI-11","command":"kernel.work.cancel.v1","emission":{"kind":"batch","eventTypes":["work.cancelled.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["nonterminal work"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore cancel","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-11"}',
  '{"id":"WI-12","command":"kernel.work.retry.v1","emission":{"kind":"batch","eventTypes":["attempt.allocated.v1","work.started.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["retryOf prior terminal attempt and retry budget"],"reducerIds":["work-reducer-v1","attempt-reducer-v1"],"projectionIds":["work_projection","attempt_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore retry","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-12"}',
  '{"id":"WI-13","command":"kernel.work.exhaust_retry.v1","emission":{"kind":"batch","eventTypes":["work.retry_exhausted.v1","work.blocker_added.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["retry budget exhausted and blocker appended"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore exhaust_retry","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-13"}',
  '{"id":"WI-14","command":"kernel.work.record_outcome.v1","emission":{"kind":"batch","eventTypes":["work.outcome_recorded.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["attempt terminal and outcome immutable"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore record_outcome","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-14"}',
  '{"id":"WI-15","command":"kernel.work.archive.v1","emission":{"kind":"batch","eventTypes":["work.archived.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["no active nonterminal dependent; child lineage retained"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore archive","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-15"}',
  '{"id":"WI-16","command":"kernel.work.assign.v1","emission":{"kind":"batch","eventTypes":["work.assignment_changed.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["assignee authority exact"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore assign","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-16"}',
  '{"id":"WI-17","command":"kernel.work.set_deadline.v1","emission":{"kind":"batch","eventTypes":["work.deadline_changed.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["deadline version and DB-time basis exact"],"reducerIds":["work-reducer-v1"],"projectionIds":["work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore set_deadline","busObservation":"post-commit-lossy","testReceiptId":"TC-WI-17"}',
  '{"id":"CP-01","command":"kernel.completion.submit_candidate.v1","emission":{"kind":"batch","eventTypes":["completion.candidate.submitted.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["candidate immutable","exact criteria/claim coverage","stakes as-of ledger sequence and DB time frozen"],"reducerIds":["completion-reducer-v1"],"projectionIds":["completion_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"completion candidate store","busObservation":"post-commit-lossy","testReceiptId":"TC-CP-01"}',
  '{"id":"CP-02","command":"kernel.completion.record_verdict.v1","emission":{"kind":"batch","eventTypes":["completion.claim_verdict_recorded.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["one terminal verdict per exact claim","kernel verifier id/version exact"],"reducerIds":["completion-reducer-v1"],"projectionIds":["completion_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"VerifierRegistry result","busObservation":"post-commit-lossy","testReceiptId":"TC-CP-02"}',
  '{"id":"CP-03","command":"kernel.completion.evaluate.v1","emission":{"kind":"batch","eventTypes":["completion.candidate_rejected.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["AC-1..AC-6 total table","refutation wins over pending","high-stakes asserted escalates"],"reducerIds":["completion-reducer-v1"],"projectionIds":["completion_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"work.complete.pre gate","busObservation":"post-commit-lossy","testReceiptId":"TC-CP-03"}',
  '{"id":"CP-04","command":"kernel.completion.admit.v1","emission":{"kind":"batch","eventTypes":["completion.decision_recorded.v1","work.completed.v1"]},"ownerDerivation":"work-owner","expectedHeadAssertions":["expected work owner head"],"readAssertions":["complete terminal claim coverage","verifier refs exact","stakes threshold rule satisfied"],"reducerIds":["completion-reducer-v1","work-reducer-v1"],"projectionIds":["completion_projection","work_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkItemStore.complete","busObservation":"post-commit-lossy","testReceiptId":"TC-CP-04"}',
  '{"id":"AT-01","command":"kernel.attempt.allocate.v1","emission":{"kind":"batch","eventTypes":["attempt.allocated.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["retry policy and executor binding exact"],"reducerIds":["attempt-reducer-v1"],"projectionIds":["attempt_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerRun allocate","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-01"}',
  '{"id":"AT-02","command":"kernel.attempt.request_start.v1","emission":{"kind":"batch","eventTypes":["attempt.start_requested.v1","effect.intent.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["attempt allocated"],"reducerIds":["attempt-reducer-v1","effect-reducer-v1"],"projectionIds":["attempt_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"coordinator.spawn.v1","reconcilerId":"coordinator.spawn.v1.reconciler.v1"},"callerReplacement":"WorkerRun request_start","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-02"}',
  '{"id":"AT-03","command":"kernel.attempt.confirm_running.v1","emission":{"kind":"batch","eventTypes":["effect.confirmed.v1","attempt.running.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["confirmed start or resume effect exact; attempt remains non-running before confirmation"],"reducerIds":["attempt-reducer-v1","effect-reducer-v1"],"projectionIds":["attempt_projection","effect_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerRun confirm_running","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-03"}',
  '{"id":"AT-04","command":"kernel.attempt.start_failed.v1","emission":{"kind":"batch","eventTypes":["effect.definite_failed.v1","attempt.start_failed.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["definite start no-materialization proof"],"reducerIds":["attempt-reducer-v1","effect-reducer-v1"],"projectionIds":["attempt_projection","effect_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerRun start_failed","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-04"}',
  '{"id":"AT-05","command":"kernel.attempt.confirm_cancel.v1","emission":{"kind":"batch","eventTypes":["effect.confirmed.v1","attempt.cancelled.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["cancel effect exact"],"reducerIds":["attempt-reducer-v1","effect-reducer-v1"],"projectionIds":["attempt_projection","effect_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerRun confirm_cancel","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-05"}',
  '{"id":"AT-06","command":"kernel.attempt.interrupt_starting.v1","emission":{"kind":"batch","eventTypes":["attempt.interrupted.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["boot sees starting without materialized process"],"reducerIds":["attempt-reducer-v1"],"projectionIds":["attempt_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerRun interrupt_starting","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-06"}',
  '{"id":"AT-07","command":"kernel.attempt.wait.v1","emission":{"kind":"batch","eventTypes":["attempt.waiting.v1","wait.opened.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["one open Wait and atomic suspension"],"reducerIds":["attempt-reducer-v1","wait-reducer-v1"],"projectionIds":["attempt_projection","wait_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerRun wait","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-07"}',
  '{"id":"AT-08","command":"kernel.attempt.succeed.v1","emission":{"kind":"batch","eventTypes":["attempt.succeeded.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["running attempt"],"reducerIds":["attempt-reducer-v1"],"projectionIds":["attempt_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerRun succeed","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-08"}',
  '{"id":"AT-09","command":"kernel.attempt.fail.v1","emission":{"kind":"batch","eventTypes":["attempt.failed.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["running attempt"],"reducerIds":["attempt-reducer-v1"],"projectionIds":["attempt_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerRun fail","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-09"}',
  '{"id":"AT-10","command":"kernel.attempt.cancel_running.v1","emission":{"kind":"batch","eventTypes":["attempt.cancelled.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["running attempt"],"reducerIds":["attempt-reducer-v1"],"projectionIds":["attempt_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerRun cancel_running","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-10"}',
  '{"id":"AT-11","command":"kernel.attempt.interrupt_running.v1","emission":{"kind":"batch","eventTypes":["attempt.interrupted.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["boot confirms process absent"],"reducerIds":["attempt-reducer-v1"],"projectionIds":["attempt_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerRun interrupt_running","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-11"}',
  '{"id":"AT-12","command":"kernel.attempt.resume.v1","emission":{"kind":"batch","eventTypes":["wait.resume_requested.v1","effect.intent.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["resolved Wait records resume intent; attempt remains waiting until confirmed settlement"],"reducerIds":["wait-reducer-v1","effect-reducer-v1"],"projectionIds":["wait_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"coordinator.message.v1","reconcilerId":"coordinator.message.v1.reconciler.v1"},"callerReplacement":"WorkerRun resume","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-12"}',
  '{"id":"AT-13","command":"kernel.attempt.fail_waiting.v1","emission":{"kind":"batch","eventTypes":["effect.definite_failed.v1","attempt.failed.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["waiting attempt and exact resume delivery failure settlement"],"reducerIds":["attempt-reducer-v1","effect-reducer-v1"],"projectionIds":["attempt_projection","effect_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerRun fail_waiting","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-13"}',
  '{"id":"AT-14","command":"kernel.attempt.cancel_waiting.v1","emission":{"kind":"batch","eventTypes":["wait.cancelled.v1","attempt.cancelled.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["Wait and attempt cancel atomically"],"reducerIds":["attempt-reducer-v1","wait-reducer-v1"],"projectionIds":["attempt_projection","wait_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerRun cancel_waiting","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-14"}',
  '{"id":"AT-15","command":"kernel.attempt.interrupt_waiting.v1","emission":{"kind":"batch","eventTypes":["attempt.interrupted.v1"]},"ownerDerivation":"attempt-derived-work-owner","expectedHeadAssertions":["expected attempt owner head"],"readAssertions":["Wait remains durable and unchanged"],"reducerIds":["attempt-reducer-v1"],"projectionIds":["attempt_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerRun interrupt_waiting","busObservation":"post-commit-lossy","testReceiptId":"TC-AT-15"}',
  '{"id":"WT-01","command":"kernel.wait.open.v1","emission":{"kind":"batch","eventTypes":["wait.opened.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["expected responders/actions/quorum valid","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1"],"projectionIds":["wait_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Wait/PendingInteraction open","busObservation":"post-commit-lossy","testReceiptId":"TC-WT-01"}',
  '{"id":"WT-02","command":"kernel.wait.record_below_quorum.v1","emission":{"kind":"batch","eventTypes":["wait.response_recorded.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["unique transport id; cardinality below threshold","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1"],"projectionIds":["wait_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Wait/PendingInteraction record_below_quorum","busObservation":"post-commit-lossy","testReceiptId":"TC-WT-02"}',
  '{"id":"WT-03","command":"kernel.wait.resolve_threshold.v1","emission":{"kind":"batch","eventTypes":["wait.response_recorded.v1","wait.resolved.v1","dispatch.pending.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["first threshold and exactly one delivery","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1","dispatch-reducer-v1"],"projectionIds":["wait_projection","dispatch_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Wait/PendingInteraction resolve_threshold","busObservation":"post-commit-lossy","testReceiptId":"TC-WT-03"}',
  '{"id":"WT-04","command":"kernel.wait.record_duplicate.v1","emission":{"kind":"no-commit","reason":"receipt-idempotent"},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["same transport id/hash is receipt-idempotent; different hash rejects","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1"],"projectionIds":["wait_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Wait/PendingInteraction record_duplicate","busObservation":"none","testReceiptId":"TC-WT-04"}',
  '{"id":"WT-05","command":"kernel.wait.stage_ambiguity.v1","emission":{"kind":"batch","eventTypes":["wait.ambiguity_recorded.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["sorted candidates at surface owner","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1"],"projectionIds":["wait_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Wait/PendingInteraction stage_ambiguity","busObservation":"post-commit-lossy","testReceiptId":"TC-WT-05"}',
  '{"id":"WT-06","command":"kernel.wait.select_ambiguity.v1","emission":{"kind":"batch","eventTypes":["wait.ambiguity_selected.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["selection revalidates candidate and authority","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1"],"projectionIds":["wait_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Wait/PendingInteraction select_ambiguity","busObservation":"post-commit-lossy","testReceiptId":"TC-WT-06"}',
  '{"id":"WT-07","command":"kernel.wait.record_follow_up.v1","emission":{"kind":"batch","eventTypes":["wait.follow_up_recorded.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["resolved Wait in open follow-up window","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1"],"projectionIds":["wait_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Wait/PendingInteraction record_follow_up","busObservation":"post-commit-lossy","testReceiptId":"TC-WT-07"}',
  '{"id":"WT-08","command":"kernel.wait.cancel.v1","emission":{"kind":"batch","eventTypes":["wait.cancelled.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["open Wait","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1"],"projectionIds":["wait_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Wait/PendingInteraction cancel","busObservation":"post-commit-lossy","testReceiptId":"TC-WT-08"}',
  '{"id":"WT-09","command":"kernel.wait.expire.v1","emission":{"kind":"batch","eventTypes":["wait.expired.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["DB time strictly greater than deadline","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1"],"projectionIds":["wait_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Wait/PendingInteraction expire","busObservation":"post-commit-lossy","testReceiptId":"TC-WT-09"}',
  '{"id":"WT-10","command":"kernel.wait.resolve_partial.v1","emission":{"kind":"batch","eventTypes":["wait.resolved.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["partial allowed and DB time strictly greater than deadline","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1"],"projectionIds":["wait_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Wait/PendingInteraction resolve_partial","busObservation":"post-commit-lossy","testReceiptId":"TC-WT-10"}',
  '{"id":"WT-11","command":"kernel.wait.reject_late.v1","emission":{"kind":"no-commit","reason":"terminal-rejected"},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["terminal Wait does not mutate","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1"],"projectionIds":["wait_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Wait/PendingInteraction reject_late","busObservation":"none","testReceiptId":"TC-WT-11"}',
  '{"id":"WT-12","command":"kernel.wait.remind.v1","emission":{"kind":"batch","eventTypes":["wait.reminder_requested.v1","effect.intent.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["open Wait reminder policy","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1","effect-reducer-v1"],"projectionIds":["wait_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"wait.delivery.v1","reconcilerId":"wait.delivery.v1.reconciler.v1"},"callerReplacement":"Wait/PendingInteraction remind","busObservation":"post-commit-lossy","testReceiptId":"TC-WT-12"}',
  '{"id":"WT-13","command":"kernel.wait.resume.v1","emission":{"kind":"batch","eventTypes":["wait.resume_requested.v1","effect.intent.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["resolved Wait and stable delivery","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1","effect-reducer-v1"],"projectionIds":["wait_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"wait.delivery.v1","reconcilerId":"wait.delivery.v1.reconciler.v1"},"callerReplacement":"Wait/PendingInteraction resume","busObservation":"post-commit-lossy","testReceiptId":"TC-WT-13"}',
  '{"id":"WT-14","command":"kernel.wait.close_followups_empty.v1","emission":{"kind":"batch","eventTypes":["wait.follow_up_window_closed.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["DB time strictly greater than follow-up boundary; no follow-ups","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1"],"projectionIds":["wait_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Wait/PendingInteraction close_followups_empty","busObservation":"post-commit-lossy","testReceiptId":"TC-WT-14"}',
  '{"id":"WT-15","command":"kernel.wait.close_followups_present.v1","emission":{"kind":"batch","eventTypes":["wait.follow_up_window_closed.v1"]},"ownerDerivation":"wait-owner","expectedHeadAssertions":["expected Wait owner head"],"readAssertions":["DB time strictly greater than follow-up boundary; follow-ups retained","response threshold uses unique response map cardinality"],"reducerIds":["wait-reducer-v1"],"projectionIds":["wait_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"Wait/PendingInteraction close_followups_present","busObservation":"post-commit-lossy","testReceiptId":"TC-WT-15"}',
  '{"id":"GR-01","command":"kernel.grant.create.v1","emission":{"kind":"batch","eventTypes":["grant.created.v1"]},"ownerDerivation":"grant-owner","expectedHeadAssertions":["grant genesis head"],"readAssertions":["integer grant version exact","Attempt existence/source ref exact"],"reducerIds":["grant-reducer-v1"],"projectionIds":["worker_grant_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerGrantStore create","busObservation":"post-commit-lossy","testReceiptId":"TC-GR-01"}',
  '{"id":"GR-02","command":"kernel.grant.revoke.v1","emission":{"kind":"batch","eventTypes":["grant.revoked.v1"]},"ownerDerivation":"grant-owner","expectedHeadAssertions":["grant head exact"],"readAssertions":["integer grant version exact","Attempt existence/source ref exact"],"reducerIds":["grant-reducer-v1"],"projectionIds":["worker_grant_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerGrantStore revoke","busObservation":"post-commit-lossy","testReceiptId":"TC-GR-02"}',
  '{"id":"GR-03","command":"kernel.grant.expire.v1","emission":{"kind":"batch","eventTypes":["grant.expired.v1"]},"ownerDerivation":"grant-owner","expectedHeadAssertions":["grant head exact"],"readAssertions":["integer grant version exact","Attempt existence/source ref exact"],"reducerIds":["grant-reducer-v1"],"projectionIds":["worker_grant_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerGrantStore expire","busObservation":"post-commit-lossy","testReceiptId":"TC-GR-03"}',
  '{"id":"GR-04","command":"kernel.grant.revise.v1","emission":{"kind":"batch","eventTypes":["grant.revised.v1"]},"ownerDerivation":"grant-owner","expectedHeadAssertions":["grant head exact"],"readAssertions":["integer grant version exact","Attempt existence/source ref exact"],"reducerIds":["grant-reducer-v1"],"projectionIds":["worker_grant_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"WorkerGrantStore revise","busObservation":"post-commit-lossy","testReceiptId":"TC-GR-04"}',
  '{"id":"SC-01","command":"kernel.schedule.initialize_or_advance.v1","emission":{"kind":"batch","eventTypes":["schedule.advanced.v1"]},"ownerDerivation":"schedule-owner","expectedHeadAssertions":["schedule head and generation exact"],"readAssertions":["next UTC fire deterministic"],"reducerIds":["schedule-reducer-v1"],"projectionIds":["schedule_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"CronJobRegistry create/advance","busObservation":"post-commit-lossy","testReceiptId":"TC-SC-01"}',
  '{"id":"SC-02","command":"kernel.schedule.settle_and_advance.v1","emission":{"kind":"batch","eventTypes":["schedule.fire_settled.v1","schedule.advanced.v1"]},"ownerDerivation":"schedule-owner","expectedHeadAssertions":["schedule head and due generation exact"],"readAssertions":["fire delivered or definite-failed","unknown/transient remains pending"],"reducerIds":["schedule-reducer-v1"],"projectionIds":["schedule_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"CronJobRunner settlement","busObservation":"post-commit-lossy","testReceiptId":"TC-SC-02"}',
  '{"id":"XD-01","command":"kernel.cross_owner.deliver_pending.v1","emission":{"kind":"cross-owner","sourceEventTypes":["dispatch.pending.v1"],"destinationEventTypes":["dispatch.received.v1","effect.intent.v1"],"settlementEventTypes":["dispatch.delivered.v1"]},"ownerDerivation":"source-and-destination-owners","expectedHeadAssertions":["source pending and destination heads exact"],"readAssertions":["deterministic destination request id","destination receipt before settlement"],"reducerIds":["dispatch-reducer-v1","effect-reducer-v1"],"projectionIds":["dispatch_projection","effect_projection"],"effect":{"class":"resumable-internal","driverId":"cross-owner.delivery.v1","reconcilerId":"cross-owner.delivery.v1.reconciler.v1"},"callerReplacement":"cross-owner direct mutation","busObservation":"post-commit-lossy","testReceiptId":"TC-XD-01"}',
  '{"id":"XD-02","command":"kernel.cross_owner.settle_delivered.v1","emission":{"kind":"batch","eventTypes":["dispatch.delivered.v1"]},"ownerDerivation":"source-and-destination-owners","expectedHeadAssertions":["source head exact"],"readAssertions":["destination receipt exact","pending record exact"],"reducerIds":["dispatch-reducer-v1"],"projectionIds":["dispatch_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"cross-owner success acknowledgement","busObservation":"post-commit-lossy","testReceiptId":"TC-XD-02"}',
  '{"id":"XD-03","command":"kernel.cross_owner.settle_definite_failed.v1","emission":{"kind":"batch","eventTypes":["dispatch.failed.v1"]},"ownerDerivation":"source-and-destination-owners","expectedHeadAssertions":["source head exact"],"readAssertions":["definite destination failure proof","transient remains pending"],"reducerIds":["dispatch-reducer-v1"],"projectionIds":["dispatch_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"cross-owner failure acknowledgement","busObservation":"post-commit-lossy","testReceiptId":"TC-XD-03"}',
  '{"id":"EF-01","command":"kernel.effect.confirm.v1","emission":{"kind":"batch","eventTypes":["effect.confirmed.v1"]},"ownerDerivation":"effect-source-owner","expectedHeadAssertions":["effect source owner head exact"],"readAssertions":["pending intent exact","driver acknowledgement/idempotency key exact"],"reducerIds":["effect-reducer-v1"],"projectionIds":["effect_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"effect success settlement","busObservation":"post-commit-lossy","testReceiptId":"TC-EF-01"}',
  '{"id":"EF-02","command":"kernel.effect.fail_definite.v1","emission":{"kind":"batch","eventTypes":["effect.definite_failed.v1"]},"ownerDerivation":"effect-source-owner","expectedHeadAssertions":["effect source owner head exact"],"readAssertions":["pending intent exact","no-materialization proof exact","resume attempt remains waiting"],"reducerIds":["effect-reducer-v1"],"projectionIds":["effect_projection"],"effect":{"class":"projection","driverId":null,"reconcilerId":null},"callerReplacement":"effect definite failure settlement","busObservation":"post-commit-lossy","testReceiptId":"TC-EF-02"}',
  '{"id":"EF-03","command":"kernel.effect.mark_unknown.v1","emission":{"kind":"batch","eventTypes":["effect.unknown.v1"]},"ownerDerivation":"effect-source-owner","expectedHeadAssertions":["effect source owner head exact"],"readAssertions":["pending intent exact","ambiguous act or acknowledgement","workspace remains fail-closed","resume attempt remains waiting pending reconciliation"],"reducerIds":["effect-reducer-v1"],"projectionIds":["effect_projection"],"effect":{"class":"reconciliation","driverId":null,"reconcilerId":"effect.reconciler.v1"},"callerReplacement":"unsafe marker write","busObservation":"post-commit-lossy","testReceiptId":"TC-EF-03"}',
  '{"id":"EF-04","command":"kernel.effect.resolve_unknown.v1","emission":{"kind":"batch","eventTypes":["effect.manually_resolved.v1"]},"ownerDerivation":"effect-source-owner","expectedHeadAssertions":["effect source owner head exact"],"readAssertions":["unknown history retained","Owner identity and evidence exact","no direct clear"],"reducerIds":["effect-reducer-v1"],"projectionIds":["effect_projection"],"effect":{"class":"reconciliation","driverId":null,"reconcilerId":"effect.reconciler.v1"},"callerReplacement":"WorkspaceLock.clearUnsafe","busObservation":"post-commit-lossy","testReceiptId":"TC-EF-04"}',
] as const;

type IndependentEventOwnership = {
  readonly reducerId: string;
  readonly projectionId: string | null;
};

const own = (
  reducerId: string,
  projectionId: string | null,
  eventTypes: readonly string[],
): Record<string, IndependentEventOwnership> =>
  Object.fromEntries(eventTypes.map((eventType) => [eventType, { reducerId, projectionId }]));

const INDEPENDENT_EVENT_OWNERSHIP: Readonly<Record<string, IndependentEventOwnership>> = {
  ...own("session-reducer-v1", "session_projection", [
    "session.opened.v1",
    "session.metadata_revised.v1",
    "session.closed.v1",
    "session.expired.v1",
  ]),
  ...own("surface-binding-reducer-v1", "surface_binding_projection", [
    "surface.bound.v1",
    "surface.rebound.v1",
    "surface.unbound.v1",
  ]),
  ...own("route-reducer-v1", null, ["kernel.route.decided.v1"]),
  ...own("message-reducer-v1", "message_projection", [
    "message.inbound_recorded.v1",
    "message.assistant_started.v1",
    "message.status_changed.v1",
  ]),
  ...own("part-reducer-v1", "part_projection", [
    "message.part_appended.v1",
    "message.part_revised.v1",
  ]),
  ...own("effect-reducer-v1", "effect_projection", [
    "effect.intent.v1",
    "effect.confirmed.v1",
    "effect.definite_failed.v1",
    "effect.unknown.v1",
    "effect.manually_resolved.v1",
  ]),
  ...own("dispatch-reducer-v1", "dispatch_projection", [
    "dispatch.pending.v1",
    "dispatch.received.v1",
    "dispatch.delivered.v1",
    "dispatch.decision.v1",
    "dispatch.failed.v1",
  ]),
  ...own("work-reducer-v1", "work_projection", [
    "work.created.v1",
    "work.metadata_revised.v1",
    "work.criteria_revised.v1",
    "work.dependencies_replaced.v1",
    "work.started.v1",
    "work.evidence_recorded.v1",
    "work.readback_evidence_recorded.v1",
    "work.blocker_added.v1",
    "work.blocker_resolved.v1",
    "work.failed.v1",
    "work.cancelled.v1",
    "work.retry_exhausted.v1",
    "work.outcome_recorded.v1",
    "work.archived.v1",
    "work.assignment_changed.v1",
    "work.deadline_changed.v1",
    "work.completed.v1",
  ]),
  ...own("attempt-reducer-v1", "attempt_projection", [
    "attempt.allocated.v1",
    "attempt.start_requested.v1",
    "attempt.running.v1",
    "attempt.start_failed.v1",
    "attempt.cancelled.v1",
    "attempt.interrupted.v1",
    "attempt.waiting.v1",
    "attempt.succeeded.v1",
    "attempt.failed.v1",
  ]),
  ...own("wait-reducer-v1", "wait_projection", [
    "wait.opened.v1",
    "wait.response_recorded.v1",
    "wait.resolved.v1",
    "wait.ambiguity_recorded.v1",
    "wait.ambiguity_selected.v1",
    "wait.follow_up_recorded.v1",
    "wait.cancelled.v1",
    "wait.expired.v1",
    "wait.reminder_requested.v1",
    "wait.resume_requested.v1",
    "wait.follow_up_window_closed.v1",
  ]),
  ...own("completion-reducer-v1", "completion_projection", [
    "completion.candidate.submitted.v1",
    "completion.readback_requested.v1",
    "completion.claim_verdict_recorded.v1",
    "completion.candidate_rejected.v1",
    "completion.decision_recorded.v1",
  ]),
  ...own("schedule-reducer-v1", "schedule_projection", [
    "schedule.fire_due.v1",
    "schedule.created.v1",
    "schedule.advanced.v1",
    "schedule.cancelled.v1",
    "schedule.fire_settled.v1",
  ]),
  ...own("grant-reducer-v1", "worker_grant_projection", [
    "grant.created.v1",
    "grant.revoked.v1",
    "grant.expired.v1",
    "grant.revised.v1",
  ]),
};

const emittedEventTypes = (row: NativeTransitionCatalogRowV1): readonly string[] => {
  if (row.emission.kind === "batch") return row.emission.eventTypes;
  if (row.emission.kind === "conditional-batch") {
    return [
      ...new Set([...row.emission.sourceRunEventTypes, ...row.emission.sourceNonRunEventTypes]),
    ];
  }
  if (row.emission.kind === "no-commit") return [];
  return [
    ...row.emission.sourceEventTypes,
    ...row.emission.destinationEventTypes,
    ...row.emission.settlementEventTypes,
  ];
};

const EXPECTED_FAMILY_SIGNATURES = {
  SS: [
    "SS-01|messaging.session.open.v1|batch:session.opened.v1",
    "SS-02|messaging.session.open_child.v1|batch:session.opened.v1",
    "SS-03|messaging.session.revise_metadata.v1|batch:session.metadata_revised.v1",
    "SS-04|messaging.session.close.v1|batch:session.closed.v1",
    "SS-05|messaging.session.expire.v1|batch:session.expired.v1",
  ],
  SF: [
    "SF-01|messaging.surface.bind.v1|batch:session.opened.v1,surface.bound.v1",
    "SF-02|messaging.surface.rebind.v1|batch:surface.rebound.v1",
    "SF-03|messaging.surface.unbind.v1|batch:surface.unbound.v1",
  ],
  MS: [
    "MS-01|messaging.message.record_inbound.v1|batch:kernel.route.decided.v1,message.inbound_recorded.v1,message.part_appended.v1,message.status_changed.v1,effect.intent.v1",
    "MS-02|messaging.message.start_assistant.v1|batch:message.assistant_started.v1",
    "MS-03|messaging.message.append_part.v1|batch:message.part_appended.v1",
    "MS-04|messaging.message.revise_part.v1|batch:message.part_revised.v1",
    "MS-05|messaging.message.change_status.v1|batch:message.status_changed.v1",
    "MS-06|messaging.message.finish_assistant.v1|batch:message.assistant_started.v1,message.part_appended.v1,message.part_revised.v1,message.status_changed.v1,message.status_changed.v1",
    "MS-07|messaging.message.recover.v1|batch:message.status_changed.v1",
  ],
  RT: [
    "RT-01|kernel.route.blacklist_deny.v1|batch:kernel.route.decided.v1",
    "RT-02|kernel.route.stage_wait_ambiguity.v1|batch:kernel.route.decided.v1,wait.ambiguity_recorded.v1",
    "RT-03|kernel.route.accept_report_result.v1|cross-owner:kernel.route.decided.v1,wait.response_recorded.v1,wait.resolved.v1,dispatch.pending.v1>dispatch.received.v1,attempt.succeeded.v1,completion.candidate.submitted.v1>dispatch.delivered.v1",
    "RT-04|kernel.route.accept_clarification.v1|cross-owner:kernel.route.decided.v1,wait.response_recorded.v1,wait.resolved.v1,dispatch.pending.v1>dispatch.received.v1,effect.intent.v1>dispatch.delivered.v1",
    "RT-05|kernel.route.accept_wait_response.v1|batch:kernel.route.decided.v1,wait.response_recorded.v1,wait.resolved.v1,effect.intent.v1",
    ...[
      "unsupported_action",
      "missing_system_identity",
      "missing_channel_grant",
      "missing_actor",
      "missing_default_authority",
    ].map(
      (name, index) =>
        `RT-${String(index + 6).padStart(2, "0")}|kernel.route.${name}.v1|batch:kernel.route.decided.v1`,
    ),
    "RT-11|kernel.route.existing_resident.v1|batch:kernel.route.decided.v1,message.inbound_recorded.v1,message.part_appended.v1,message.status_changed.v1,effect.intent.v1",
    "RT-12|kernel.route.new_resident.v1|batch:session.opened.v1,surface.bound.v1,kernel.route.decided.v1,message.inbound_recorded.v1,message.part_appended.v1,message.status_changed.v1,effect.intent.v1",
    "RT-13|kernel.route.active_worker.v1|cross-owner:kernel.route.decided.v1,message.inbound_recorded.v1,message.part_appended.v1,message.status_changed.v1,dispatch.pending.v1>dispatch.received.v1,effect.intent.v1>dispatch.delivered.v1",
    ...["foreground_worker", "background_worker"].map(
      (name, index) =>
        `RT-${index + 14}|kernel.route.new_${name}.v1|cross-owner:kernel.route.decided.v1,message.inbound_recorded.v1,message.part_appended.v1,message.status_changed.v1,dispatch.pending.v1>dispatch.received.v1,work.created.v1,attempt.allocated.v1,effect.intent.v1>dispatch.delivered.v1`,
    ),
    "RT-16|kernel.route.stop_or_cancel.v1|cross-owner:kernel.route.decided.v1,dispatch.pending.v1>dispatch.received.v1,dispatch.decision.v1,effect.intent.v1>dispatch.delivered.v1",
    "RT-17|kernel.route.schedule_fire.v1|cross-owner:schedule.fire_due.v1,dispatch.pending.v1>dispatch.received.v1,kernel.route.decided.v1,effect.intent.v1>dispatch.delivered.v1",
  ],
  DP: [
    ...["deny", "pending", "unsupported_actor_message", "unknown_action"].map(
      (name, index) =>
        `DP-${String(index + 1).padStart(2, "0")}|kernel.dispatch.${name}.v1|batch:dispatch.decision.v1`,
    ),
    "DP-05|kernel.dispatch.spawn_worker.v1|batch:dispatch.decision.v1,work.created.v1,attempt.allocated.v1,effect.intent.v1",
    "DP-06|kernel.dispatch.connector_submit.v1|batch:dispatch.decision.v1,effect.intent.v1",
    "DP-07|kernel.dispatch.submit_completion.v1|batch:dispatch.decision.v1,attempt.succeeded.v1,completion.candidate.submitted.v1",
    "DP-08|kernel.dispatch.submit_completion_readback.v1|batch:dispatch.decision.v1,attempt.succeeded.v1,completion.candidate.submitted.v1,completion.readback_requested.v1,effect.intent.v1",
    "DP-09|kernel.dispatch.cancel_work.v1|batch:dispatch.decision.v1,work.cancelled.v1",
    "DP-10|kernel.dispatch.fail_work.v1|batch:dispatch.decision.v1,work.failed.v1",
    "DP-11|kernel.dispatch.interrupt_attempt.v1|batch:dispatch.decision.v1,attempt.interrupted.v1",
    "DP-12|kernel.dispatch.message_worker.v1|cross-owner:dispatch.decision.v1,dispatch.pending.v1>dispatch.received.v1,effect.intent.v1>dispatch.delivered.v1",
    "DP-13|kernel.dispatch.resume_wait.v1|batch:dispatch.decision.v1,wait.resume_requested.v1,effect.intent.v1",
    "DP-14|kernel.dispatch.ensure_cancel.v1|batch:dispatch.decision.v1,effect.intent.v1",
    "DP-15|kernel.dispatch.ask_resident.v1|conditional-batch:source-run=wait.opened.v1,dispatch.pending.v1,attempt.waiting.v1;source-non-run=wait.opened.v1,dispatch.pending.v1",
    "DP-16|kernel.dispatch.accept_response.v1|batch:dispatch.decision.v1,wait.response_recorded.v1,wait.resolved.v1,effect.intent.v1",
    "DP-17|kernel.dispatch.actor_fire_and_forget.v1|batch:dispatch.decision.v1,effect.intent.v1",
    "DP-18|kernel.dispatch.actor_awaited.v1|cross-owner:dispatch.decision.v1,wait.opened.v1,dispatch.pending.v1>dispatch.received.v1,effect.intent.v1>dispatch.delivered.v1",
    ...["external_submit", "a2a_submit", "api_submit", "device_submit"].map(
      (name, index) =>
        `DP-${index + 19}|kernel.dispatch.${name}.v1|batch:dispatch.decision.v1,effect.intent.v1`,
    ),
    "DP-23|kernel.dispatch.schedule_create.v1|batch:dispatch.decision.v1,schedule.created.v1,schedule.advanced.v1",
    "DP-24|kernel.dispatch.schedule_cancel.v1|batch:dispatch.decision.v1,schedule.cancelled.v1",
  ],
  WI: [
    "create|work.created.v1",
    "revise_metadata|work.metadata_revised.v1",
    "revise_criteria|work.criteria_revised.v1",
    "replace_dependencies|work.dependencies_replaced.v1",
    "start|work.started.v1",
    "record_evidence|work.evidence_recorded.v1",
    "record_readback|work.readback_evidence_recorded.v1",
    "add_blocker|work.blocker_added.v1",
    "resolve_blocker|work.blocker_resolved.v1",
    "fail|work.failed.v1",
    "cancel|work.cancelled.v1",
    "retry|attempt.allocated.v1,work.started.v1",
    "exhaust_retry|work.retry_exhausted.v1,work.blocker_added.v1",
    "record_outcome|work.outcome_recorded.v1",
    "archive|work.archived.v1",
    "assign|work.assignment_changed.v1",
    "set_deadline|work.deadline_changed.v1",
  ].map(
    (signature, index) =>
      `WI-${String(index + 1).padStart(2, "0")}|kernel.work.${signature.replace("|", ".v1|batch:")}`,
  ),
  CP: [
    "CP-01|kernel.completion.submit_candidate.v1|batch:completion.candidate.submitted.v1",
    "CP-02|kernel.completion.record_verdict.v1|batch:completion.claim_verdict_recorded.v1",
    "CP-03|kernel.completion.evaluate.v1|batch:completion.candidate_rejected.v1",
    "CP-04|kernel.completion.admit.v1|batch:completion.decision_recorded.v1,work.completed.v1",
  ],
  AT: [
    "allocate|attempt.allocated.v1",
    "request_start|attempt.start_requested.v1,effect.intent.v1",
    "confirm_running|effect.confirmed.v1,attempt.running.v1",
    "start_failed|effect.definite_failed.v1,attempt.start_failed.v1",
    "confirm_cancel|effect.confirmed.v1,attempt.cancelled.v1",
    "interrupt_starting|attempt.interrupted.v1",
    "wait|attempt.waiting.v1,wait.opened.v1",
    "succeed|attempt.succeeded.v1",
    "fail|attempt.failed.v1",
    "cancel_running|attempt.cancelled.v1",
    "interrupt_running|attempt.interrupted.v1",
    "resume|wait.resume_requested.v1,effect.intent.v1",
    "fail_waiting|effect.definite_failed.v1,attempt.failed.v1",
    "cancel_waiting|wait.cancelled.v1,attempt.cancelled.v1",
    "interrupt_waiting|attempt.interrupted.v1",
  ].map(
    (signature, index) =>
      `AT-${String(index + 1).padStart(2, "0")}|kernel.attempt.${signature.replace("|", ".v1|batch:")}`,
  ),
  WT: [
    "open|batch:wait.opened.v1",
    "record_below_quorum|batch:wait.response_recorded.v1",
    "resolve_threshold|batch:wait.response_recorded.v1,wait.resolved.v1,dispatch.pending.v1",
    "record_duplicate|no-commit:receipt-idempotent",
    "stage_ambiguity|batch:wait.ambiguity_recorded.v1",
    "select_ambiguity|batch:wait.ambiguity_selected.v1",
    "record_follow_up|batch:wait.follow_up_recorded.v1",
    "cancel|batch:wait.cancelled.v1",
    "expire|batch:wait.expired.v1",
    "resolve_partial|batch:wait.resolved.v1",
    "reject_late|no-commit:terminal-rejected",
    "remind|batch:wait.reminder_requested.v1,effect.intent.v1",
    "resume|batch:wait.resume_requested.v1,effect.intent.v1",
    "close_followups_empty|batch:wait.follow_up_window_closed.v1",
    "close_followups_present|batch:wait.follow_up_window_closed.v1",
  ].map(
    (signature, index) =>
      `WT-${String(index + 1).padStart(2, "0")}|kernel.wait.${signature.replace("|", ".v1|")}`,
  ),
  GR: [
    "create|grant.created.v1",
    "revoke|grant.revoked.v1",
    "expire|grant.expired.v1",
    "revise|grant.revised.v1",
  ].map(
    (signature, index) =>
      `GR-${String(index + 1).padStart(2, "0")}|kernel.grant.${signature.replace("|", ".v1|batch:")}`,
  ),
  SC: [
    "SC-01|kernel.schedule.initialize_or_advance.v1|batch:schedule.advanced.v1",
    "SC-02|kernel.schedule.settle_and_advance.v1|batch:schedule.fire_settled.v1,schedule.advanced.v1",
  ],
  XD: [
    "XD-01|kernel.cross_owner.deliver_pending.v1|cross-owner:dispatch.pending.v1>dispatch.received.v1,effect.intent.v1>dispatch.delivered.v1",
    "XD-02|kernel.cross_owner.settle_delivered.v1|batch:dispatch.delivered.v1",
    "XD-03|kernel.cross_owner.settle_definite_failed.v1|batch:dispatch.failed.v1",
  ],
  EF: [
    "EF-01|kernel.effect.confirm.v1|batch:effect.confirmed.v1",
    "EF-02|kernel.effect.fail_definite.v1|batch:effect.definite_failed.v1",
    "EF-03|kernel.effect.mark_unknown.v1|batch:effect.unknown.v1",
    "EF-04|kernel.effect.resolve_unknown.v1|batch:effect.manually_resolved.v1",
  ],
} as const;

const EXPECTED_CONFIGURATION_COMMANDS = [
  "AF-01|artifact.put_and_reference.v1",
  "AI-01|kernel.actor.register_identity.v1",
  "AI-02|kernel.actor.revise_identity.v1",
  "AI-03|kernel.actor.retire_identity.v1",
  "AE-01|kernel.actor.bind_endpoint.v1",
  "AE-02|kernel.actor.rebind_endpoint.v1",
  "AE-03|kernel.actor.unbind_endpoint.v1",
  "BL-01|kernel.authority.create_blacklist.v1",
  "BL-02|kernel.authority.revise_blacklist.v1",
  "BL-03|kernel.authority.revoke_blacklist.v1",
  "BL-04|kernel.authority.expire_blacklist.v1",
  "CG-01|kernel.authority.create_channel_grant.v1",
  "CG-02|kernel.authority.revise_channel_grant.v1",
  "CG-03|kernel.authority.revoke_channel_grant.v1",
  "CI-01|kernel.connector.register_installation.v1",
  "CI-02|kernel.connector.revise_definition.v1",
  "CI-03|kernel.connector.request_consent.v1",
  "CI-04|kernel.connector.grant_consent.v1",
  "CI-05|kernel.connector.request_verification.v1",
  "CI-06|kernel.connector.record_verified.v1",
  "CI-07|kernel.connector.record_verification_failed.v1",
  "CI-08|kernel.connector.disable.v1",
  "CI-09|kernel.connector.uninstall.v1",
] as const;

const EXPECTED_CONFIGURATION_EVENTS = [
  "artifact.referenced.v1",
  "actor.identity_registered.v1",
  "actor.identity_revised.v1",
  "actor.identity_retired.v1",
  "actor.endpoint_bound.v1",
  "actor.endpoint_rebound.v1",
  "actor.endpoint_unbound.v1",
  "authority.blacklist_created.v1",
  "authority.blacklist_revised.v1",
  "authority.blacklist_revoked.v1",
  "authority.blacklist_expired.v1",
  "authority.channel_grant_created.v1",
  "authority.channel_grant_revised.v1",
  "authority.channel_grant_revoked.v1",
  "connector.installation_registered.v1",
  "connector.definition_revised.v1",
  "connector.consent_requested.v1",
  "connector.consent_granted.v1",
  "connector.verification_requested.v1",
  "connector.verified.v1",
  "connector.verification_failed.v1",
  "connector.disabled.v1",
  "connector.uninstalled.v1",
] as const;
describe("revision-9 native transition catalog", () => {
  test("is closed and has exact family cardinalities", () => {
    expect(NATIVE_TRANSITION_CATALOG_R9).toHaveLength(120);
    for (const [family, count] of Object.entries(NATIVE_TRANSITION_FAMILY_CARDINALITIES)) {
      expect(
        NATIVE_TRANSITION_CATALOG_R9.filter((row) => row.id.startsWith(`${family}-`)),
      ).toHaveLength(count);
    }

    const independentlySpecified = Object.values(EXPECTED_FAMILY_SIGNATURES).flat();
    expect(independentlySpecified).toHaveLength(120);
    const actualSpecified = NATIVE_TRANSITION_CATALOG_R9.filter((row) =>
      independentlySpecified.some((signature) => signature.startsWith(`${row.id}|`)),
    ).map((row) => `${row.id}|${row.command}|${emissionSignature(row)}`);
    expect(actualSpecified).toEqual(independentlySpecified);
    expect(() => nativeTransitionById("WI-18")).toThrow("transition_forbidden");
  });

  test("catalogs exact artifact/configuration operations against protocol contracts", () => {
    expect(CONFIGURATION_OPERATION_CATALOG_V1).toHaveLength(23);
    expect(CLOSED_OPERATION_CATALOG_V1).toHaveLength(143);
    expect(CONFIGURATION_OPERATION_FAMILY_CARDINALITIES).toEqual({
      AF: 1,
      AI: 3,
      AE: 3,
      BL: 4,
      CG: 3,
      CI: 9,
    });
    expect(CONFIGURATION_OPERATION_CATALOG_V1.map(({ id, command }) => `${id}|${command}`)).toEqual(
      EXPECTED_CONFIGURATION_COMMANDS,
    );
    expect(
      Execution.ConfigurationOperationCatalogV1.map(({ id, command }) => `${id}|${command}`),
    ).toEqual(EXPECTED_CONFIGURATION_COMMANDS);
    expect(
      CONFIGURATION_OPERATION_CATALOG_V1.map((row) => {
        expect(row.emission.kind).toBe("batch");
        if (row.emission.kind !== "batch") throw new Error(`unexpected emission ${row.id}`);
        expect(row.expectedHeadAssertions.length).toBeGreaterThan(0);
        expect(row.readAssertions.length).toBeGreaterThan(0);
        expect(row.reducerIds).toHaveLength(1);
        expect(row.projectionIds).toHaveLength(1);
        expect(row.callerReplacement.length).toBeGreaterThan(0);
        expect(row.testReceiptId).toBe(`TC-${row.id}`);
        return row.emission.eventTypes[0];
      }),
    ).toEqual(EXPECTED_CONFIGURATION_EVENTS);
  });

  test("exports an exact version and a deeply immutable catalog graph", () => {
    expect(NATIVE_TRANSITION_CATALOG_VERSION).toBe("native-transition-catalog-r9-v1");
    expect(Object.isFrozen(NATIVE_TRANSITION_FAMILY_CARDINALITIES)).toBe(true);
    expect(() => Object.assign(NATIVE_TRANSITION_FAMILY_CARDINALITIES, { SS: 99 })).toThrow(
      TypeError,
    );
    expect(Object.isFrozen(NATIVE_TRANSITION_CATALOG_R9)).toBe(true);
    expect(() => Object.assign(NATIVE_TRANSITION_CATALOG_R9, { 0: null })).toThrow(TypeError);

    for (const catalogRow of NATIVE_TRANSITION_CATALOG_R9) {
      expect(Object.isFrozen(catalogRow), catalogRow.id).toBe(true);
      expect(Object.isFrozen(catalogRow.effect), catalogRow.id).toBe(true);
      expect(Object.isFrozen(catalogRow.emission), catalogRow.id).toBe(true);
      expect(() => Object.assign(catalogRow, { command: "runtime-drift" }), catalogRow.id).toThrow(
        TypeError,
      );
      expect(
        () => Object.assign(catalogRow.effect, { driverId: "runtime-drift" }),
        catalogRow.id,
      ).toThrow(TypeError);
      expect(
        () => Object.assign(catalogRow.emission, { kind: "runtime-drift" }),
        catalogRow.id,
      ).toThrow(TypeError);

      const nestedArrays: readonly (readonly string[])[] = [
        catalogRow.expectedHeadAssertions,
        catalogRow.readAssertions,
        catalogRow.reducerIds,
        catalogRow.projectionIds,
        ...(catalogRow.emission.kind === "batch"
          ? [catalogRow.emission.eventTypes]
          : catalogRow.emission.kind === "conditional-batch"
            ? [catalogRow.emission.sourceRunEventTypes, catalogRow.emission.sourceNonRunEventTypes]
            : catalogRow.emission.kind === "cross-owner"
              ? [
                  catalogRow.emission.sourceEventTypes,
                  catalogRow.emission.destinationEventTypes,
                  catalogRow.emission.settlementEventTypes,
                ]
              : []),
      ];
      for (const nestedArray of nestedArrays) {
        expect(Object.isFrozen(nestedArray), catalogRow.id).toBe(true);
        expect(() => Object.assign(nestedArray, { 0: "runtime-drift" }), catalogRow.id).toThrow(
          TypeError,
        );
      }
    }
  });

  test("matches the independently reviewed exhaustive full-row golden", () => {
    expect(NATIVE_TRANSITION_CATALOG_R9.map(fullRowSignature)).toEqual(
      EXPECTED_FULL_ROW_SERIALIZATIONS,
    );
  });

  test("the full-row golden detects representative drift in every public field", () => {
    const mutations: ReadonlyArray<{
      readonly field: keyof NativeTransitionCatalogRowV1;
      readonly apply: (row: NativeTransitionCatalogRowV1) => NativeTransitionCatalogRowV1;
    }> = [
      { field: "id", apply: (row) => ({ ...row, id: "SS-99" as never }) },
      { field: "command", apply: (row) => ({ ...row, command: `${row.command}-drift` }) },
      {
        field: "emission",
        apply: (row) => ({
          ...row,
          emission: { kind: "batch", eventTypes: ["session.closed.v1"] },
        }),
      },
      { field: "ownerDerivation", apply: (row) => ({ ...row, ownerDerivation: "work-owner" }) },
      {
        field: "expectedHeadAssertions",
        apply: (row) => ({
          ...row,
          expectedHeadAssertions: [...row.expectedHeadAssertions, "drift"],
        }),
      },
      {
        field: "readAssertions",
        apply: (row) => ({ ...row, readAssertions: [...row.readAssertions, "drift"] }),
      },
      {
        field: "reducerIds",
        apply: (row) => ({ ...row, reducerIds: [...row.reducerIds, "drift"] }),
      },
      {
        field: "projectionIds",
        apply: (row) => ({ ...row, projectionIds: [...row.projectionIds, "drift"] }),
      },
      {
        field: "effect",
        apply: (row) => ({ ...row, effect: { ...row.effect, driverId: "drift" } }),
      },
      { field: "busObservation", apply: (row) => ({ ...row, busObservation: "none" }) },
      { field: "callerReplacement", apply: (row) => ({ ...row, callerReplacement: "drift" }) },
      { field: "testReceiptId", apply: (row) => ({ ...row, testReceiptId: "TC-drift" as never }) },
    ];

    expect(mutations.map(({ field }) => field)).toEqual([
      "id",
      "command",
      "emission",
      "ownerDerivation",
      "expectedHeadAssertions",
      "readAssertions",
      "reducerIds",
      "projectionIds",
      "effect",
      "busObservation",
      "callerReplacement",
      "testReceiptId",
    ]);
    for (const { field, apply } of mutations) {
      const rows = cloneRows();
      rows[0] = apply(rows[0]);
      expect(rows.map(fullRowSignature), field).not.toEqual(EXPECTED_FULL_ROW_SERIALIZATIONS);
      expect(() => validateNativeTransitionCatalog(rows), field).toThrow();
    }
  });

  test("locks the exhaustive event ownership census and rejects every omitted relation", () => {
    const actualEventCensus = [
      ...new Set(NATIVE_TRANSITION_CATALOG_R9.flatMap((row) => emittedEventTypes(row))),
    ].sort();
    expect(actualEventCensus).toEqual(Object.keys(INDEPENDENT_EVENT_OWNERSHIP).sort());
    expect([...ProtocolLedger.NativeEventTypeV1.options].sort()).toEqual(
      [...Object.keys(INDEPENDENT_EVENT_OWNERSHIP), ...EXPECTED_CONFIGURATION_EVENTS].sort(),
    );

    for (const catalogRow of NATIVE_TRANSITION_CATALOG_R9) {
      for (const eventType of new Set(emittedEventTypes(catalogRow))) {
        const ownership = INDEPENDENT_EVENT_OWNERSHIP[eventType];
        expect(ownership, `${catalogRow.id} ${eventType}`).toBeDefined();
        if (!ownership) throw new Error(`missing independent ownership for ${eventType}`);

        const missingReducer = cloneRows();
        const reducerIndex = missingReducer.findIndex((row) => row.id === catalogRow.id);
        missingReducer[reducerIndex] = {
          ...missingReducer[reducerIndex],
          reducerIds: missingReducer[reducerIndex].reducerIds.filter(
            (reducerId) => reducerId !== ownership.reducerId,
          ),
        };
        expect(() => validateNativeTransitionCatalog(missingReducer)).toThrow("event ownership");

        if (ownership.projectionId !== null) {
          const missingProjection = cloneRows();
          const projectionIndex = missingProjection.findIndex((row) => row.id === catalogRow.id);
          missingProjection[projectionIndex] = {
            ...missingProjection[projectionIndex],
            projectionIds: missingProjection[projectionIndex].projectionIds.filter(
              (projectionId) => projectionId !== ownership.projectionId,
            ),
          };
          expect(() => validateNativeTransitionCatalog(missingProjection)).toThrow(
            "event ownership",
          );
        }
      }
    }
  });

  test("records message-part, effect, and pending-dispatch owners on affected transitions", () => {
    for (const id of ["RT-11", "RT-12", "RT-13", "RT-14", "RT-15"]) {
      expect(nativeTransitionById(id).reducerIds).toContain("part-reducer-v1");
      expect(nativeTransitionById(id).projectionIds).toContain("part_projection");
    }
    for (const id of ["AT-02", "AT-03", "AT-04", "AT-05", "AT-12", "AT-13", "WT-12", "WT-13"]) {
      expect(nativeTransitionById(id).reducerIds).toContain("effect-reducer-v1");
      expect(nativeTransitionById(id).projectionIds).toContain("effect_projection");
    }
    expect(nativeTransitionById("WT-03").reducerIds).toContain("dispatch-reducer-v1");
    expect(nativeTransitionById("WT-03").projectionIds).toContain("dispatch_projection");
    expect(nativeTransitionById("WI-12").reducerIds).toContain("attempt-reducer-v1");
    expect(nativeTransitionById("WI-12").projectionIds).toContain("attempt_projection");
  });

  test("rejects missing, duplicate, unversioned, wrong-family, and non-v1 event rows", () => {
    expect(() => validateNativeTransitionCatalog(cloneRows().slice(1))).toThrow("cardinality");

    const duplicate = cloneRows();
    duplicate[1] = duplicate[0];
    expect(() => validateNativeTransitionCatalog(duplicate)).toThrow("duplicate transition id");

    const unversioned = cloneRows();
    unversioned[0] = { ...unversioned[0], command: "messaging.session.open" };
    expect(() => validateNativeTransitionCatalog(unversioned)).toThrow("unversioned command");

    const wrongFamily = cloneRows();
    wrongFamily[0] = { ...wrongFamily[0], command: "kernel.work.create.v1" };
    expect(() => validateNativeTransitionCatalog(wrongFamily)).toThrow("wrong-family command");

    const wrongEventVersion = cloneRows();
    wrongEventVersion[0] = {
      ...wrongEventVersion[0],
      emission: { kind: "batch", eventTypes: ["session.opened.v2"] },
    };
    expect(() => validateNativeTransitionCatalog(wrongEventVersion)).toThrow(
      "event version is not v1",
    );

    const uncataloguedEvent = cloneRows();
    uncataloguedEvent[0] = {
      ...uncataloguedEvent[0],
      emission: { kind: "batch", eventTypes: ["session.invented.v1"] },
    };
    expect(() => validateNativeTransitionCatalog(uncataloguedEvent)).toThrow(
      "uncatalogued event ownership",
    );

    const incompleteCensus = cloneRows();
    const completionAdmitIndex = incompleteCensus.findIndex((row) => row.id === "CP-04");
    incompleteCensus[completionAdmitIndex] = {
      ...incompleteCensus[completionAdmitIndex],
      emission: {
        kind: "batch",
        eventTypes: ["completion.decision_recorded.v1", "work.failed.v1"],
      },
    };
    expect(() => validateNativeTransitionCatalog(incompleteCensus)).toThrow("catalog row mismatch");
  });

  test("rejects malformed rows across every structural guard", () => {
    const malformed = cloneRows();
    malformed[0] = { ...malformed[0], id: "SS-x" as never };
    expect(() => validateNativeTransitionCatalog(malformed)).toThrow("unlisted transition id");

    const outOfRange = cloneRows();
    outOfRange[0] = { ...outOfRange[0], id: "SS-06" as never };
    expect(() => validateNativeTransitionCatalog(outOfRange)).toThrow("out-of-range transition id");

    const incompleteCrossOwner = cloneRows();
    const crossOwnerIndex = incompleteCrossOwner.findIndex((row) => row.id === "XD-01");
    incompleteCrossOwner[crossOwnerIndex] = {
      ...incompleteCrossOwner[crossOwnerIndex],
      emission: {
        kind: "cross-owner",
        sourceEventTypes: [],
        destinationEventTypes: ["dispatch.received.v1"],
        settlementEventTypes: ["dispatch.delivered.v1"],
      },
    };
    expect(() => validateNativeTransitionCatalog(incompleteCrossOwner)).toThrow(
      "incomplete cross-owner",
    );

    const incompleteConditionalBatch = cloneRows();
    const conditionalBatchIndex = incompleteConditionalBatch.findIndex((row) => row.id === "DP-15");
    incompleteConditionalBatch[conditionalBatchIndex] = {
      ...incompleteConditionalBatch[conditionalBatchIndex],
      emission: {
        kind: "conditional-batch",
        sourceRunEventTypes: ["wait.opened.v1", "dispatch.pending.v1", "attempt.waiting.v1"],
        sourceNonRunEventTypes: [],
      },
    };
    expect(() => validateNativeTransitionCatalog(incompleteConditionalBatch)).toThrow(
      "incomplete conditional-batch",
    );

    for (const field of [
      "expectedHeadAssertions",
      "readAssertions",
      "reducerIds",
      "projectionIds",
    ] as const) {
      const rows = cloneRows();
      rows[0] = { ...rows[0], [field]: [] };
      const expectedError = field.endsWith("Assertions")
        ? "missing assertion"
        : "missing reducer/projection event ownership";
      expect(() => validateNativeTransitionCatalog(rows)).toThrow(expectedError);
    }

    const invalidReceipt = cloneRows();
    invalidReceipt[0] = { ...invalidReceipt[0], testReceiptId: "TC-SS-02" as never };
    expect(() => validateNativeTransitionCatalog(invalidReceipt)).toThrow("invalid receipt");

    const invalidEffect = cloneRows();
    invalidEffect[0] = {
      ...invalidEffect[0],
      effect: { class: "projection", driverId: "bad.v1", reconcilerId: null },
    };
    expect(() => validateNativeTransitionCatalog(invalidEffect)).toThrow("invalid effect binding");

    const genericMismatch = cloneRows();
    genericMismatch[0] = { ...genericMismatch[0], callerReplacement: "" };
    expect(() => validateNativeTransitionCatalog(genericMismatch)).toThrow("catalog row mismatch");
  });

  test("rejects semantic drift, invented commands, duplicate ownership, and surplus ownership", () => {
    const inventedCommand = cloneRows();
    inventedCommand[0] = {
      ...inventedCommand[0],
      command: "messaging.session.invented.v1",
    };
    expect(() => validateNativeTransitionCatalog(inventedCommand)).toThrow("noncanonical command");

    const duplicateReducer = cloneRows();
    duplicateReducer[0] = {
      ...duplicateReducer[0],
      reducerIds: ["session-reducer-v1", "session-reducer-v1"],
    };
    expect(() => validateNativeTransitionCatalog(duplicateReducer)).toThrow(
      "noncanonical reducer/projection ownership",
    );

    const duplicateProjection = cloneRows();
    duplicateProjection[0] = {
      ...duplicateProjection[0],
      projectionIds: ["session_projection", "session_projection"],
    };
    expect(() => validateNativeTransitionCatalog(duplicateProjection)).toThrow(
      "noncanonical reducer/projection ownership",
    );

    const surplusReducer = cloneRows();
    surplusReducer[0] = {
      ...surplusReducer[0],
      reducerIds: ["session-reducer-v1", "work-reducer-v1"],
    };
    expect(() => validateNativeTransitionCatalog(surplusReducer)).toThrow(
      "noncanonical reducer/projection ownership",
    );

    const surplusProjection = cloneRows();
    surplusProjection[0] = {
      ...surplusProjection[0],
      projectionIds: ["session_projection", "work_projection"],
    };
    expect(() => validateNativeTransitionCatalog(surplusProjection)).toThrow(
      "noncanonical reducer/projection ownership",
    );

    const wrongObservation = cloneRows();
    wrongObservation[0] = { ...wrongObservation[0], busObservation: "none" };
    expect(() => validateNativeTransitionCatalog(wrongObservation)).toThrow("catalog row mismatch");

    const unregisteredReconciler = cloneRows();
    const effectIndex = unregisteredReconciler.findIndex((row) => row.id === "MS-01");
    unregisteredReconciler[effectIndex] = {
      ...unregisteredReconciler[effectIndex],
      effect: {
        ...unregisteredReconciler[effectIndex].effect,
        reconcilerId: "resident.run.v1.invented-reconciler.v1",
      },
    };
    expect(() => validateNativeTransitionCatalog(unregisteredReconciler)).toThrow(
      "unregistered reconciler",
    );

    const wrongRegisteredReconciler = cloneRows();
    wrongRegisteredReconciler[effectIndex] = {
      ...wrongRegisteredReconciler[effectIndex],
      effect: {
        ...wrongRegisteredReconciler[effectIndex].effect,
        reconcilerId: "wait.delivery.v1.reconciler.v1",
      },
    };
    expect(() => validateNativeTransitionCatalog(wrongRegisteredReconciler)).toThrow(
      "catalog row mismatch",
    );
  });

  test("locks projectionless routes and exact terminal ownership", () => {
    for (const id of ["RT-01", "RT-06", "RT-07", "RT-08", "RT-09", "RT-10"]) {
      expect(nativeTransitionById(id).projectionIds).toEqual([]);
    }
    expect(nativeTransitionById("MS-07").reducerIds).toEqual(["message-reducer-v1"]);
    expect(nativeTransitionById("MS-07").projectionIds).toEqual(["message_projection"]);
    expect(nativeTransitionById("DP-09").reducerIds).toEqual([
      "dispatch-reducer-v1",
      "work-reducer-v1",
    ]);
    expect(nativeTransitionById("DP-11").reducerIds).toEqual([
      "dispatch-reducer-v1",
      "attempt-reducer-v1",
    ]);
    expect(nativeTransitionById("DP-17").reducerIds).toEqual([
      "dispatch-reducer-v1",
      "effect-reducer-v1",
    ]);
  });

  test("makes ask-resident branches and background return semantics exact", () => {
    expect(nativeTransitionById("DP-15").emission).toEqual({
      kind: "conditional-batch",
      sourceRunEventTypes: ["wait.opened.v1", "dispatch.pending.v1", "attempt.waiting.v1"],
      sourceNonRunEventTypes: ["wait.opened.v1", "dispatch.pending.v1"],
    });
    expect(nativeTransitionById("DP-15").reducerIds).toEqual([
      "wait-reducer-v1",
      "dispatch-reducer-v1",
      "attempt-reducer-v1",
    ]);
    expect(nativeTransitionById("RT-14").readAssertions).not.toContain(
      "background returns only after source commit",
    );
    expect(nativeTransitionById("RT-15").readAssertions).toContain(
      "background returns only after source commit",
    );
  });

  test("keeps resume two-phase and represents every settlement branch without false running", () => {
    expect(nativeTransitionById("AT-12").emission).toEqual({
      kind: "batch",
      eventTypes: ["wait.resume_requested.v1", "effect.intent.v1"],
    });
    expect(nativeTransitionById("AT-12").reducerIds).not.toContain("attempt-reducer-v1");
    expect(nativeTransitionById("AT-03").emission).toEqual({
      kind: "batch",
      eventTypes: ["effect.confirmed.v1", "attempt.running.v1"],
    });
    expect(nativeTransitionById("AT-13").emission).toEqual({
      kind: "batch",
      eventTypes: ["effect.definite_failed.v1", "attempt.failed.v1"],
    });
    expect(nativeTransitionById("EF-02").emission).toEqual({
      kind: "batch",
      eventTypes: ["effect.definite_failed.v1"],
    });
    expect(nativeTransitionById("EF-03").emission).toEqual({
      kind: "batch",
      eventTypes: ["effect.unknown.v1"],
    });
    expect(nativeTransitionById("EF-02").readAssertions).toContain(
      "resume attempt remains waiting",
    );
    expect(nativeTransitionById("EF-03").readAssertions).toContain(
      "resume attempt remains waiting pending reconciliation",
    );

    const runningEmitters = NATIVE_TRANSITION_CATALOG_R9.filter((row) =>
      emittedEventTypes(row).includes("attempt.running.v1"),
    );
    expect(runningEmitters.map((row) => row.id)).toEqual(["AT-03"]);
    expect(emittedEventTypes(runningEmitters[0])).toContain("effect.confirmed.v1");
  });
  test("makes Wait threshold and Work parent proof explicit", () => {
    const threshold = nativeTransitionById("WT-03");
    expect(threshold.emission.kind).toBe("batch");
    expect(threshold.readAssertions.join(" ")).toContain("first threshold");
    expect(threshold.readAssertions.join(" ")).toContain("map cardinality");
    expect(nativeTransitionById("WT-04").emission).toEqual({
      kind: "no-commit",
      reason: "receipt-idempotent",
    });
    expect(nativeTransitionById("WT-11").emission).toEqual({
      kind: "no-commit",
      reason: "terminal-rejected",
    });

    const workCreate = nativeTransitionById("WI-01");
    expect(workCreate.readAssertions.join(" ")).toContain("parent proof/head");
    expect(workCreate.expectedHeadAssertions).toEqual(["work genesis head"]);
  });

  test("makes completion, unknown effects, reconciliation, and cross-owner pending explicit", () => {
    expect(nativeTransitionById("CP-03").readAssertions.join(" ")).toContain(
      "refutation wins over pending",
    );
    expect(nativeTransitionById("CP-04").readAssertions.join(" ")).toContain("stakes threshold");
    expect(nativeTransitionById("EF-03").emission).toEqual({
      kind: "batch",
      eventTypes: ["effect.unknown.v1"],
    });
    expect(nativeTransitionById("EF-04").effect.class).toBe("reconciliation");

    const pending = nativeTransitionById("XD-01");
    expect(pending.emission.kind).toBe("cross-owner");
    if (pending.emission.kind === "cross-owner") {
      expect(pending.emission.sourceEventTypes).toEqual(["dispatch.pending.v1"]);
      expect(pending.emission.settlementEventTypes).toEqual(["dispatch.delivered.v1"]);
    }
  });
});
