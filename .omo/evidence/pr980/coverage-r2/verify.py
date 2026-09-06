"""Capture final independent commands with nested-runtime and cleanup receipts."""
from pathlib import Path
import datetime, hashlib, json, os, subprocess, sys, tempfile

root = Path(__file__).resolve().parents[4]
out = Path(__file__).resolve().parent
lane = sys.argv[1]
commands = {
    'agent-ci': 'cd packages/agent && PATH=/Users/ino/.local/share/mise/installs/bun/1.3.6/bin:$PATH bun run test:ci',
    'app-wave': 'cd apps/openomni && PATH=/Users/ino/.local/share/mise/installs/bun/1.3.6/bin:$PATH bun test --timeout 15000 test/session-wave-e2e.test.ts',
    'llm': 'cd packages/llm && PATH=/Users/ino/.local/share/mise/installs/bun/1.3.6/bin:$PATH bun test --timeout 15000',
}
command = commands[lane]
temp = Path(tempfile.gettempdir())
before = sorted(str(p) for p in temp.glob('openomni-937-*'))
start = datetime.datetime.now(datetime.timezone.utc).isoformat()
result = subprocess.run(['bash', '-c', command], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)
raw = result.stdout
log = out / (lane + '-1.3.6.txt')
log.write_text(raw)
after = sorted(str(p) for p in temp.glob('openomni-937-*'))
receipt = dict(command=command, start=start, end=datetime.datetime.now(datetime.timezone.utc).isoformat(),
               code=result.returncode, banner='bun test v1.3.6 (d530ed99)' in raw,
               log_sha256=hashlib.sha256(log.read_bytes()).hexdigest(),
               temp_before=before, temp_after=after)
if lane == 'agent-ci':
    lcov = (root / 'packages/agent/coverage/lcov.info').read_bytes()
    (out / 'final-agent.lcov.info').write_bytes(lcov)
    receipt['lcov_sha256'] = hashlib.sha256(lcov).hexdigest()
(out / (lane + '-receipt.json')).write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt, indent=2))
print('\n'.join(raw.splitlines()[-7:]))
assert receipt['banner'], 'nested test runtime was not pinned'
assert result.returncode == 0
if lane == 'app-wave':
    assert before == after, 'real app left temporary state behind'
