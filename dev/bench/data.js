window.BENCHMARK_DATA = {
  "lastUpdate": 1779129354569,
  "repoUrl": "https://github.com/INONONO66/openomni",
  "entries": {
    "OpenOmni Benchmarks": [
      {
        "commit": {
          "author": {
            "email": "inonono66@gmail.com",
            "name": "INONONO",
            "username": "INONONO66"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "5181a2f7f875ba1276c0519bfa692c5214f3cb9c",
          "message": "refactor(agent,openomni): remove dead code and unused modules (#173)\n\n* refactor(agent): remove unused builtin policies and memory module\n\nremove memory, post-tool, and post-turn builtins that have zero\nproduction consumers. clean all references from policy registry,\nbuiltin index, stream-helpers, types, and snapshot tests.\n\n* refactor(openomni): remove unused DAG module\n\nDAG scheduler has zero runtime consumers. remove module,\ntests, and barrel export.\n\n* refactor(openomni): remove empty mcp-proxy-provider placeholder\n\n* fix(openomni): remove DAG references from bench and memory tests",
          "timestamp": "2026-05-19T02:52:23+09:00",
          "tree_id": "2374db3377a9e8047a731f175319f589a3331bb2",
          "url": "https://github.com/INONONO66/openomni/commit/5181a2f7f875ba1276c0519bfa692c5214f3cb9c"
        },
        "date": 1779126813301,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 747.8230547766339,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 878.7907955673699,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1599.9921281257914,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.976980611904715,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 739.7218001730913,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 443.5195990597622,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3369.5133095222136,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2628.6492915911927,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11677.344231666799,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6195.2172593235,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1974,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19600,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2477,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8409,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16082,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 813,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1609,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8702,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 80169,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 399524,
            "unit": "ns/op"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "inonono66@gmail.com",
            "name": "INONONO",
            "username": "INONONO66"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "b1b2a64d85738c265c27f8888a9459d7e3082f95",
          "message": "refactor(coordinator,session): reuse protocol worker contracts\n\nReuse protocol-owned worker/tool contracts from coordinator and session aliases, with typechecked contract coverage.",
          "timestamp": "2026-05-19T03:35:22+09:00",
          "tree_id": "5bc1c74dc5ea411148d705844614f31622ed9396",
          "url": "https://github.com/INONONO66/openomni/commit/b1b2a64d85738c265c27f8888a9459d7e3082f95"
        },
        "date": 1779129354288,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 1235.8583345692286,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 833.4951699075161,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1714.5449807114314,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.123894355793816,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 636.2829291881476,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.5129621094176,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2814.9956650249364,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2507.657405085489,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9860.563301123317,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5917.07727353408,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2714,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 23396,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2470,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7955,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15075,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 747,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1779,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8933,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 80795,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 426206,
            "unit": "ns/op"
          }
        ]
      }
    ]
  }
}