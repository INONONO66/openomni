"""Temporary test-only mutation probes; restore each production file in finally.
Each probe runs only its named behavioral oracle, never counts unrelated failures.
"""
from pathlib import Path
import os, subprocess, json, datetime, hashlib, re

root = Path(__file__).resolve().parents[4]
out = Path(__file__).resolve().parent
os.chdir(root)
env = {**os.environ, 'PATH': '/Users/ino/.local/share/mise/installs/bun/1.3.6/bin:' + os.environ['PATH']}
wave = 'packages/agent/src/core/execution/tool-wave.ts'
approval = 'packages/agent/src/executor-approval.ts'
executor = 'packages/agent/src/executor.ts'
session = 'packages/agent/src/session-handle.ts'
wave_test = 'packages/agent/test/core/execution/tool-wave.test.ts'
approval_test = 'packages/agent/test/executor-approval.test.ts'
session_test = 'packages/agent/test/session-handle.test.ts'
mutants = []
def add(name, source, old, new, test, title):
    mutants.append((name, source, old, new, test, title))

for settlement, old, new in [
 ('fulfillment', 'if (!outcomes.has(index)) outcomes.set(index, { status: "fulfilled", value });', 'outcomes.set(index, { status: "fulfilled", value });'),
 ('rejection', 'if (!outcomes.has(index))\n          outcomes.set(index, {', 'if (true)\n          outcomes.set(index, {'),
]:
    add('wave-' + settlement + '-overwrite', wave, old, new, wave_test, 'does not let a late body ' + settlement + ' overwrite cancellation')
add('wave-join-poison', wave, '} catch (error) {\n        if (!outcomes.has(index))', '} catch (error) {\n        throw error;\n        if (!outcomes.has(index))', wave_test, 'keeps a sequential barrier after preceding rejection and runs later work')

for decision in ['approve', 'refuse']:
    title = f'commits authenticated {decision} before releasing the suspended body'
    add('answer-' + decision, approval, 'pending.resolve(answer.decision);', 'pending.resolve("refuse");' if decision == 'approve' else 'pending.resolve("approve");', approval_test, title)
    add('snapshot-' + decision, approval, 'structuredClone(value.request)', 'value.request', approval_test, title)
    add('evidence-' + decision, approval, '            evidence,\n            request: pending.request,', '            evidence: null,\n            request: pending.request,', approval_test, title)
    add('authority-credential-' + decision, approval, 'options.authorizeApproval(answer.credential, pending.request)', 'options.authorizeApproval("wrong-token", pending.request)', approval_test, title)
    add('identity-' + decision, executor, 'toolsGeneration: options.identity.toolsGeneration', 'toolsGeneration: 0', approval_test, title)
    add('input-hash-' + decision, executor, 'inputHash: canonicalDigest(stage.request.intent)', 'inputHash: canonicalDigest(null)', approval_test, title)
    add('answer-parent-' + decision, approval, 'parentId: pending.request.id,', 'parentId: null,', approval_test, title)
    add('answer-record-' + decision, approval, 'await commit({\n        id: options.entropy(),\n        parentId: pending.request.id,', 'await Promise.resolve({\n        id: options.entropy(),\n        parentId: pending.request.id,', approval_test, title)

for label, old, new in [
 ('forged-request', 'canonicalDigest(PlainValueSchema.parse(answer.request))', 'canonicalDigest(PlainValueSchema.parse(pending.request))'),
 ('unavailable-authority', 'throw new ExecutionApprovalError("approval_authority_unavailable");', 'return;'),
]:
    add(label, approval, old, new, approval_test, 'rejects forged requests and unavailable approval authority without releasing the body')
recheck = '''      if (
        pending.answering ||
        pending.signal.aborted ||
        expired(pending.request) ||
        pendingApprovals.get(answer.request.id) !== pending
      ) {
        throw new ExecutionApprovalError("stale_approval");
      }
'''
add('post-authorize-cancellation', approval, recheck, '', approval_test, 'rechecks cancellation after asynchronous owner authorization')
expiry_title = 'records expiry once at the deadline and cancels its scheduled callback'
add('early-expiry', approval, 'pending === undefined || pending.answering || signal.aborted || !expired(request)', 'pending === undefined || pending.answering || signal.aborted', approval_test, expiry_title)
add('expiry-evidence', approval, 'evidence: { kind: "deadline", at: options.clock(), expiresAt: request.expiresAt }', 'evidence: { kind: "deadline", at: 0, expiresAt: request.expiresAt }', approval_test, expiry_title)
add('expiry-registration', approval, 'options.scheduleApprovalTimeout(callback, options.approvalTimeoutMs)', 'options.scheduleApprovalTimeout(callback, 0)', approval_test, expiry_title)
add('expiry-timestamp', approval, 'expiresAt: options.clock() + options.approvalTimeoutMs', 'expiresAt: options.clock() + options.approvalTimeoutMs + 1', approval_test, expiry_title)
add('expiry-cancel', approval, 'cancelDeadline?.();', '// mutant: deadline cancellation removed', approval_test, expiry_title)
add('native-expiry', approval, 'decision.resolve("timeout");', 'decision.resolve("approve");', approval_test, 'uses the native timer for an immediate approval deadline')
error_title = 'propagates a failed deadline commit and clears the suspended approval'
add('expiry-failure', approval, 'expire().catch(decision.reject)', 'expire().catch(() => decision.resolve("timeout"))', approval_test, error_title)
add('expiry-failure-cleanup', approval, 'signal.removeEventListener("abort", abort);\n      pendingApprovals.delete(request.id);', 'signal.removeEventListener("abort", abort);', approval_test, error_title)
add('invalid-deadline', approval, 'options.approvalTimeoutMs < 0', 'options.approvalTimeoutMs < -1', approval_test, 'rejects invalid approval deadlines before admitting execution')

add('usage-required-value', session, '    inputTokens,\n    outputTokens,\n    totalTokens,', '    inputTokens,\n    outputTokens,\n    totalTokens: 0,', session_test, 'validates transformed session usage with required counters')
for counter in ['reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']:
    add('usage-' + counter, session, '...(KEY === undefined ? {} : { KEY })'.replace('KEY', counter), '...(KEY === undefined ? {} : { KEY: 0 })'.replace('KEY', counter), session_test, 'validates transformed session usage with optional counters')
add('usage-required-check', session, 'if (!finiteNumber(inputTokens) || !finiteNumber(outputTokens) || !finiteNumber(totalTokens))', 'if (false)', session_test, 'validates transformed session usage with missing required counter')
add('usage-optional-check', session, 'if (reasoningTokens === false || cacheReadTokens === false || cacheWriteTokens === false)', 'if (false)', session_test, 'validates transformed session usage with invalid optional counter')
add('usage-unknown-check', session, '!onlyKeys(value, [\n      "inputTokens",', 'false && !onlyKeys(value, [\n      "inputTokens",', session_test, 'validates transformed session usage with unknown counter')
add('compaction-kept-boundary', 'packages/agent/src/compaction/durable.ts', 'if (firstKeptIndex < 0)', 'if (false)', 'packages/agent/test/core/execution/compaction-node.test.ts', 'refuses compaction restoration when the original kept boundary is missing')

results = []
for name, source, old, new, test, title in mutants:
    path = root / source
    original = path.read_text()
    assert original.count(old) == 1, (name, original.count(old))
    before = hashlib.sha256(original.encode()).hexdigest()
    try:
        path.write_text(original.replace(old, new))
        result = subprocess.run(['bun', 'test', '--timeout', '15000', test, '-t', re.escape(title)], env=env, capture_output=True, text=True, timeout=30)
        raw = result.stdout + result.stderr
        (out / (name + '.txt')).write_text(raw)
        results.append(dict(name=name, test=title, code=result.returncode,
                            discriminated=result.returncode != 0 and '(fail) ' in raw and title in raw,
                            deadline_failure='error: approval event deadline' in raw or 'timed out after' in raw,
                            at=datetime.datetime.now(datetime.timezone.utc).isoformat(), source_sha256=before))
    finally:
        path.write_text(original)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
(out / 'mutations.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results, indent=2))
assert all(r['discriminated'] and not r['deadline_failure'] for r in results)
