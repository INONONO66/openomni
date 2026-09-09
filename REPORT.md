# CI critical-path investigation

Baseline run `34313881130` (main `8c55e0e1`) measured scripts-tooling shards at 2.8, 9.6, and 4.2 minutes; publisher was 10.2 minutes and was cancelled at the 20-minute limit in run `34310546345`.

The per-file timings from the baseline coverage artifacts were packed longest-first into explicit lists with projected totals of 280s, 280s, and 296s (about 4.7, 4.7, and 4.9 minutes). The manifest test remains fail-closed for missing, duplicate, and unassigned files, and a command test confirms all files are selected exactly once.

Publisher was not split: `check-census.ts` constructs one whole-program provenance graph and publisher findings include negative declarations and shared invocation paths. Root partitioning would not preserve byte identity. The publisher matrix leg therefore gets a 30-minute timeout, documented with run `34310546345`.

Benchmark PR filtering is limited to packages/ledger, packages/agent, and packages/protocol; main pushes and weekly schedule remain full. `quality-mutation` had zero runs when checked (`gh run list`); its weekly cron was changed to daily to obtain scheduled evidence.

Local full script run had one unrelated pre-existing Knip fixture failure because Bun's temporary knip package lacked `formatly`; Python fixture failures were avoided with pinned Python 3.12.12.
