window.BENCHMARK_DATA = {
  "lastUpdate": 1781285982484,
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
          "id": "a1e63081ad95f064e66eef814f284d63e3d9335c",
          "message": "refactor(server,agent): consolidate runtime contracts\n\nConsolidate server MCP/agent runtime contracts and apply preserved MCP headers/retries in the runtime client.",
          "timestamp": "2026-05-19T04:57:12+09:00",
          "tree_id": "0ec9a44e378753a3fd5248bc939305f0ab43e863",
          "url": "https://github.com/INONONO66/openomni/commit/a1e63081ad95f064e66eef814f284d63e3d9335c"
        },
        "date": 1779134257913,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 718.1179938672799,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 860.5145254281733,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1374.0803138353813,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.03114213705527,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 837.0702799983294,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 504.2109363182814,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2903.0504252906967,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2538.1016497466903,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9599.355250527338,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5969.866515431155,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1998,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20824,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2370,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8053,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15693,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 732,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1582,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8782,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 79353,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 392523,
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
          "id": "b1b88977f486dcb9077b51d4adb34b84953a5c06",
          "message": "refactor(server,openomni): propagate per-agent policy plans\n\nPropagate per-agent policy plans through runtime boundaries while preserving legacy permission behavior.",
          "timestamp": "2026-05-19T06:23:45+09:00",
          "tree_id": "2222c013928811d5c244b7a012311416148b13cf",
          "url": "https://github.com/INONONO66/openomni/commit/b1b88977f486dcb9077b51d4adb34b84953a5c06"
        },
        "date": 1779139456226,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 789.375267399718,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 891.6745564239308,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1642.1850890879973,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.07314890765632,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 758.5020593299361,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 472.36363378719284,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3316.655732811143,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2614.0316290258,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11036.942942280692,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6209.046318142447,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2359,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20613,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2495,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 10143,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 19289,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 763,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1515,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 9138,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 81602,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 408064,
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
          "id": "934d258c0b14e5c73ebb1339099f05eb09b70fe0",
          "message": "refactor(agent,openomni): make policy middleware caller-owned\n\nMove default policy assembly out of ChatAgent core and into runtime builders while preserving worker, resident, and subagent behavior.",
          "timestamp": "2026-05-19T07:00:30+09:00",
          "tree_id": "945a72875a8399b4744ef548424c9c00aee4290a",
          "url": "https://github.com/INONONO66/openomni/commit/934d258c0b14e5c73ebb1339099f05eb09b70fe0"
        },
        "date": 1779141658977,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 781.0792632919487,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 851.6856960353698,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1394.5270534098884,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.10758633353282,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 667.7936319258195,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 589.8350468034047,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3052.4157077013033,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2722.66184758613,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11238.679253764687,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6407.792785288203,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1951,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19374,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2604,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8444,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16102,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 805,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1580,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 9366,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 85300,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 427732,
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
          "id": "6634d0b482c7fe8e07a627f2df590a91c68c7c3b",
          "message": "refactor(openomni,server): isolate subagent admission policy\n\nBuild child runtime policy from explicit child context only while keeping parent policy plans on the delegation admission path. Preserve effective child permissions for admission summaries and default child denylist behavior across post-admission constraint updates.",
          "timestamp": "2026-05-19T07:58:19+09:00",
          "tree_id": "200ce1a42fef1cdcd1f04a9c4d84cd4ab2133576",
          "url": "https://github.com/INONONO66/openomni/commit/6634d0b482c7fe8e07a627f2df590a91c68c7c3b"
        },
        "date": 1779145124987,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 818.1770683334713,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 848.1293857232689,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1394.7459901252528,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.55059238500851,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 637.3173834348767,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 501.4362125678233,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2919.7229197085953,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2522.8659114988695,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9417.551087673679,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5830.594600898086,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2007,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20469,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2882,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8033,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15339,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 699,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1638,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 9468,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 80146,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 397774,
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
          "id": "8caeadc758f802bdf5d33c5851628c596c39efef",
          "message": "refactor(agent): split stream execution modules\n\nSplit stream execution helper internals into focused modules and tighten deny diagnostic identity coverage.",
          "timestamp": "2026-05-19T09:44:18+09:00",
          "tree_id": "c719db03f2e3568ad2001423128ac456c811789c",
          "url": "https://github.com/INONONO66/openomni/commit/8caeadc758f802bdf5d33c5851628c596c39efef"
        },
        "date": 1779151481197,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 703.0577842459884,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 810.4752927825339,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1335.4645771293524,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.95407234962392,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 604.494517252169,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 449.3304860841816,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2896.718845953334,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2500.865981443801,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9214.54095641743,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5866.608412531376,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2730,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20174,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2332,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7896,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15061,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 731,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1600,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8878,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 79447,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 389602,
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
          "id": "cee031b72ed2e2296d12b96426a0e1703b26d158",
          "message": "refactor(openomni): dedupe background limit policy\n\nReplace the legacy background-limit policy implementation with a compatibility alias to the canonical middleware evaluator.",
          "timestamp": "2026-05-19T10:08:33+09:00",
          "tree_id": "79f26c39de8eb17c21f1af4db6f4b26a3dc0ec5a",
          "url": "https://github.com/INONONO66/openomni/commit/cee031b72ed2e2296d12b96426a0e1703b26d158"
        },
        "date": 1779152941400,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 678.9206411709874,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 777.5481766579281,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1273.3913231718307,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.82463012071067,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 577.4979469972009,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 440.4811320340012,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2692.143164809199,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2590.0908078427565,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8927.379753615507,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5949.466297817452,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1950,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20226,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2380,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7860,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14764,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 786,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1605,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8916,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 80324,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 403334,
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
          "id": "627a555afb83572396617f4211681e1162090b44",
          "message": "refactor(protocol): split policy module\n\nSplit the protocol policy namespace into cohesive modules while preserving the public policy surface and hardening input-rule validation.",
          "timestamp": "2026-05-19T11:34:44+09:00",
          "tree_id": "d684e6faf10010951add3a35cfc7189229217c72",
          "url": "https://github.com/INONONO66/openomni/commit/627a555afb83572396617f4211681e1162090b44"
        },
        "date": 1779158108441,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 776.5905815109564,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 876.8136782112498,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1480.7263789145495,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 52.30512762710873,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 647.1592006316652,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 479.77669388085064,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2956.7594985363057,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2598.896096470834,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9749.789217119886,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6145.384440483991,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2090,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19562,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2457,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8478,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16168,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 1022,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1596,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 9388,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 84808,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 419895,
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
          "id": "af03a0f00454792b2222cc65c71788e782638bf0",
          "message": "refactor(session): split sqlite storage adapters\n\nSplit SQLite storage persistence into focused sub-adapter modules while preserving adapter shape and SQL behavior.",
          "timestamp": "2026-05-19T12:06:34+09:00",
          "tree_id": "25cf064d0b8d89a8a3bd42544ac5fdcda4783cfe",
          "url": "https://github.com/INONONO66/openomni/commit/af03a0f00454792b2222cc65c71788e782638bf0"
        },
        "date": 1779160019246,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 680.3661382500117,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 774.6313848823121,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1254.9881656058803,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.07541101527605,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 572.3126137469769,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 444.49075683299986,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2942.519810571537,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2509.131852967022,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9012.298215573224,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5868.12733247292,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1964,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20170,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2297,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7833,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14698,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 708,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1555,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8779,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 79278,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 393703,
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
          "id": "3ec208a9797a941ecec410d6bbc578f14a1169e2",
          "message": "refactor(openomni): split skill module into focused files (#183)\n\n* refactor(openomni): split skill index into focused modules\n\nExtract skill/index.ts (467 LOC) into 5 focused modules:\n- shared.ts (67 LOC): path resolution, sort utilities, constants\n- registry.ts (48 LOC): SkillRegistry namespace (read/write)\n- markdown.ts (162 LOC): SKILL.md parsing and metadata extraction\n- descriptors.ts (67 LOC): runtime resource descriptor attachment\n- loader.ts (111 LOC): SkillLoader namespace (discover/load)\n\nindex.ts becomes a 16 LOC barrel re-export.\n\n* refactor(openomni): split skill manager into audit and io modules\n\nExtract manager.ts (637 LOC) into 3 focused modules:\n- manager.ts (242 LOC): SkillManager namespace operations only\n- manager-audit.ts (269 LOC): audit pipeline, policy evaluation, Bus events\n- manager-io.ts (129 LOC): registry/definition file I/O, serialization\n\nEliminates duplicate utility functions by importing from shared.ts.\n\n* fix(openomni): address skill module review feedback\n\n- Add assertSafeSkillId guard to SkillLoader.loadLocal/loadGlobal to\n  prevent path traversal via untrusted skill IDs\n- Deduplicate SkillAction type by exporting from manager-audit and\n  importing in manager\n- Replace duplicate readRegistry in manager-io with SkillRegistry.read\n  to eliminate maintenance drift\n- Move assertSafeSkillId to shared.ts as single source of truth\n\n* fix(openomni): harden skill path safety and metadata parsing\n\n- Add assertSafeSkillId to readLocalEntries to skip unsafe directory\n  names from readdir results (defense in depth)\n- Fix multiline pipe metadata values getting unintended leading newline\n  when first continuation line follows empty initial value",
          "timestamp": "2026-05-20T15:19:42+09:00",
          "tree_id": "3fc0fe5015b92cef1c722b752b2120ae0aa6fbd2",
          "url": "https://github.com/INONONO66/openomni/commit/3ec208a9797a941ecec410d6bbc578f14a1169e2"
        },
        "date": 1779258008027,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 693.8593413912836,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 824.8902902769045,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1304.5939232645667,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.048681719978674,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 628.0186709874372,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448.78609126494786,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2898.426873804654,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2498.009192646014,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9531.381910026159,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5847.592445327908,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2570,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21074,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2374,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 11017,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15094,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 696,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1583,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8838,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 79743,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 394747,
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
          "id": "ef7c8729e71c46192c8aee7c5498b86fbcc7e33a",
          "message": "feat(openomni): unified inbound_message IPC syscall (#185)\n\n* feat(openomni): add injection queue for async inbound message responses\n\n* feat(protocol): add cron job registry schema\n\n* feat(protocol): add inbound message schema and bus events\n\n* feat(openomni): add ingress action permission checks\n\n* feat(openomni): add injection queue drain policy at turn.finish\n\n* feat(openomni): implement inbound_message tool with sync and async modes\n\n* feat(openomni): add circular message depth tracking\n\n* feat(openomni): add sync wait mechanism with occupied slot protection\n\n* feat(server): wire CronAdapter in bootstrap with schedule action\n\n* refactor(openomni,server): remove legacy resident worker tools\n\n* refactor(server): migrate worker ask_main to inbound_message sync mode\n\n* refactor(server): replace check_inbox polling with injection queue\n\n* refactor(coordinator): update IPC handlers for inbound_message sync mode\n\n* refactor(server): remove empty worker internal tools\n\n* docs(openomni): update AGENTS.md for inbound_message architecture\n\n* test(openomni,server): add integration tests for inbound_message flows\n\n* fix(openomni,server): add injection queue bus events and update docs\n\n* test(openomni): update authority error message after T3 action checks\n\n* fix(openomni,coordinator): address PR review feedback\n\n* docs(openomni): remove unlisted export from module map",
          "timestamp": "2026-05-20T16:04:18+09:00",
          "tree_id": "ebe3a9430cc7b3c997b1fbd264dd80e47792fdbb",
          "url": "https://github.com/INONONO66/openomni/commit/ef7c8729e71c46192c8aee7c5498b86fbcc7e33a"
        },
        "date": 1779260686149,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 682.8621306583474,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 845.7424560217047,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1313.0917040888753,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.92860987413272,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 619.6258790871627,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 474.0413342624303,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2917.0157225365742,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2490.0573954183183,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11690.081122151312,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5919.685491031659,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2094,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21463,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2566,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8140,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15483,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 758,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1580,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8948,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 90784,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 399236,
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
          "id": "34b731b0d86aaec09cc4200bb195a8bdbd3ac681",
          "message": "docs: overhaul public documentation and terminology (#186)\n\n* docs: move internal docs to .local.md (untracked)\n\nRemove golden-principles, repository-guidelines, observability-doctrine,\npolicy-kernel-spec, and quality-score from committed docs. These are\ninternal development references, not public-facing documentation.\nContent preserved as .local.md files (gitignored).\n\n* docs: replace persona-workforce with core-model\n\nRemove persona-workforce.md (old Main Persona / Sub Persona terminology)\nand replace with core-model.md using new product vocabulary:\nResident, Worker, System Governor.\n\nCovers: single Resident, Workers as applications, System Governor,\ncontrolled inbound authority, execution layers, session hygiene,\nworker lifecycle, memory readiness, and terminology mapping table.\n\n* docs: update design-philosophy for new terminology\n\nReplace Main Persona with Resident, workers with Workers (capital W),\nadd System Governor as the driver of the compounding loop.\nRemove 'What OpenOmni Is' section (now covered by README).\nTighten from 86 to 82 lines.\n\n* docs: rewrite README for new product model\n\nReplace implementation-heavy README with conceptual entry point.\nNew terminology (Resident, Worker, System Governor) throughout.\nRemove System Architecture, Documentation Map, runtime details.\nKeep Development commands and License. Add Further Reading links.\n\n* docs: add CONTRIBUTING.md\n\nMinimal contributing guide: prerequisites, setup, dev commands,\ncode style, commit message format, architecture overview, license.\n\n* docs: update cross-references for new doc structure\n\nUpdate AGENTS.md, ADR-007, ADR-008, and protocol AGENTS.md to\nreference core-model.md instead of persona-workforce.md. Replace\nlinks to removed internal docs with .local.md references. Align\nproduct model table with Resident/Worker/Governor terminology.\n\n* docs: align remaining references with new terminology\n\nUpdate ADR-007, openomni AGENTS.md, and ingress-engine.md to use\nResident/Worker terminology instead of Main Persona/Sub Persona.\n\n* docs: add project evolution narrative to ADR index\n\nGroup ADRs into foundation, agent architecture, product model,\nand runtime capabilities phases. Add brief descriptions of how\neach phase built on the previous one.",
          "timestamp": "2026-05-20T22:14:03+09:00",
          "tree_id": "7180628b403b64c8c1303b7a1b15abbeb472a032",
          "url": "https://github.com/INONONO66/openomni/commit/34b731b0d86aaec09cc4200bb195a8bdbd3ac681"
        },
        "date": 1779282879099,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 675.6089923317998,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 840.1345302405024,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1405.916200410684,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.27731682410522,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 639.5469871196659,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 451.6828790170303,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3096.1888352216292,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2529.3477842980096,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11340.855749603465,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5996.860578076484,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2209,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20936,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2366,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8110,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15358,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 746,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1601,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 9083,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 80909,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 409544,
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
          "id": "539234a70351ea561b92a727a916c739c1b515cd",
          "message": "docs: update AGENTS.md files for new terminology and stale content (#187)\n\n* docs(session,openomni,server): update AGENTS.md terminology and modules\n\nsession: replace persona workforce terminology with Resident/Worker\nopenomni: add profile/ and resident/ to module map and deps\nserver: add resident profile subsystem documentation\n\n* docs(llm): remove stale OAuth references from AGENTS.md\n\nOAuth auth was removed; only api and proxy auth types remain.\nUpdate Auth.Info description and registry.ts comment.\n\n* docs: fix stale OAuth reference in root AGENTS.md\n\n* docs: fix remaining persona references in AGENTS.md files\n\n* chore: update check-deps tracked docs for new doc structure\n\nRemove deleted docs (golden-principles.md, quality-score.md) from\nTRACKED_DOCS. Add coordinator and server AGENTS.md. Update\ngolden-principles.md references to .local.md paths.",
          "timestamp": "2026-05-21T03:27:35+09:00",
          "tree_id": "4e5c15c33bb946ed52bf7097762351dc4408e281",
          "url": "https://github.com/INONONO66/openomni/commit/539234a70351ea561b92a727a916c739c1b515cd"
        },
        "date": 1779301682834,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 701.9330221457896,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 824.9209562461708,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1350.2418141799578,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.05311449242714,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 654.8560458415684,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 483.90213109840226,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3025.683579921833,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2563.1572984750815,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10090.187872061311,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5904.680444024813,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2029,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21049,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2366,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7954,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15107,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 756,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1724,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 9126,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 81916,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 403824,
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
          "id": "1e421639eee2fbbf17bac8d9f8bda530c6fc77b2",
          "message": "refactor(server): split channel authn middleware (#190)\n\nCloses #188",
          "timestamp": "2026-05-23T01:58:12+09:00",
          "tree_id": "e6af31f1a87cc5ce95b0ebc2792619dc7dc33cca",
          "url": "https://github.com/INONONO66/openomni/commit/1e421639eee2fbbf17bac8d9f8bda530c6fc77b2"
        },
        "date": 1779469121093,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 739.8427243940043,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 921.5756559244415,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1343.1422105221573,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 51.32006059868137,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 673.4086963548546,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 490.3307770760403,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3033.7221430084946,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2671.627928722429,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9788.662783868016,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6162.2296647771445,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2048,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19732,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2511,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8471,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16228,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 765,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1701,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 9538,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 96862,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 530227,
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
          "id": "af2cc5fe0a12e97ba87721a6a76b1d7856c702bb",
          "message": "refactor(server): split MCP provider internals (#192)\n\nCloses #191",
          "timestamp": "2026-05-23T02:08:40+09:00",
          "tree_id": "5d8b24e279b033b3fea5466f07820612c3cd7325",
          "url": "https://github.com/INONONO66/openomni/commit/af2cc5fe0a12e97ba87721a6a76b1d7856c702bb"
        },
        "date": 1779469752687,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 712.6487934892543,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 954.1643067057148,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1569.834636275348,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 48.70785467720141,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 619.8887366724803,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 449.87004188274227,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2869.933390730756,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2517.4711124536034,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10061.429922526806,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5884.620336590132,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1942,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20033,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2320,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8054,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15248,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 708,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1823,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 9189,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 85800,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 406924,
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
          "id": "1657299ff1c1e57a4ed22855a79a8f1d45bc2f93",
          "message": "fix(session): validate sqlite reads and snapshot observability (#194)\n\n* fix(session): validate sqlite reads and snapshot observability\n\nCloses #193\n\n* perf(session): cache validated session rows\n\n* fix(session): preserve session write compatibility",
          "timestamp": "2026-05-23T02:35:09+09:00",
          "tree_id": "a278d2cb98b46e2539464a2eb770649e46c42ede",
          "url": "https://github.com/INONONO66/openomni/commit/1657299ff1c1e57a4ed22855a79a8f1d45bc2f93"
        },
        "date": 1779471337627,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 750.0986603259006,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 818.9945782590472,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1345.3909563017692,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.06750751195086,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 629.0067743943549,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 463.31771955428997,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2966.753493339699,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2571.734061977683,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9641.953143077631,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6004.129322766813,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2255,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20209,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2428,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8102,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15349,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 690,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1565,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10929,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102568,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 516734,
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
          "id": "9eaa047b18a8886e252db86e15f218e0239f1ff6",
          "message": "feat(openomni,server): add built-in resident prompt and make SOUL.md optional (#196)\n\n* feat(openomni): add resident agent prompt with model-specific variants\n\nResidentAgent namespace provides getPrompt({ model }) which selects\na Claude or GPT prompt variant based on the provider. Prompt sections\ncover identity, operating philosophy, philosophical alignment, workflow,\ndelegation, tool use, verification, and boundaries.\n\nExported from packages/openomni barrel as ResidentAgent.\n\n* feat(server): use built-in resident prompt, make SOUL.md optional\n\ncreateResidentProfile() now uses ResidentAgent.getPrompt({ model }) as\nthe base system prompt. SOUL.md is no longer required — when present it\noverlays onto the base prompt as a Soul section. USER.md, MEMORY.md, and\nconfig.yaml remain optional overlays.\n\nRemoves requiredText() since all profile files are now optional. Updates\ntests to verify built-in prompt fallback and Soul overlay behavior.\n\n* docs: update AGENTS.md for resident prompt domain\n\nAdd agents/resident/prompt/ to openomni module map, dependency shape,\nand public surface. Update server AGENTS.md to reflect SOUL.md is now\noptional with built-in prompt as base. Add WHERE TO LOOK entry in root.\nRemove stale storage/AGENTS.md.",
          "timestamp": "2026-05-25T14:01:24Z",
          "tree_id": "efb4992105c5d34490cc03802ca7d04eccfd6ffe",
          "url": "https://github.com/INONONO66/openomni/commit/9eaa047b18a8886e252db86e15f218e0239f1ff6"
        },
        "date": 1779717713909,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 754.325468246694,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 892.3728772722775,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1521.5439648221407,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.581351472405345,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 717.618435593795,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 473.9661304541971,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3086.9336317334173,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2601.8243267856546,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11158.526608772987,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6199.395387762461,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2362,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19491,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2475,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8422,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16058,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 720,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1501,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10862,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102959,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 548224,
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
          "id": "ec8a0b324fd3a981e85bfcac24843aa78abc70b8",
          "message": "feat(llm,server): proxy model discovery and improved default selection (#197)\n\n* feat(llm): add proxy model discovery via /v1/models\n\nWhen auth type is proxy, Provider.listModels() now queries the proxy\nendpoint /v1/models to discover available models. Results are cached\nwith a 5-minute TTL and enriched with models.dev catalog metadata.\n\nNon-bundled proxy providers fall back to @ai-sdk/openai instead of\n@ai-sdk/openai-compatible to avoid AI SDK 6 spec v1 rejection.\nRemove CODEX-only filter for openai proxy — proxy availability is\nthe filter now.\n\n* feat(server): select default model by release date\n\nresolveDefaultProviderModel() now sorts candidate models by\nrelease_date descending before picking the default, replacing the\nprevious arbitrary Object.values() ordering.\n\n* test(llm): update proxy model tests for CODEX filter removal\n\nProxy auth no longer restricts OpenAI models to CODEX-only list.\nUpdate assertions to reflect that all catalog models are returned\nfor both proxy and API auth types.",
          "timestamp": "2026-05-25T15:13:04Z",
          "tree_id": "93a62571a89ba52507634213070af5c1e95ba4c2",
          "url": "https://github.com/INONONO66/openomni/commit/ec8a0b324fd3a981e85bfcac24843aa78abc70b8"
        },
        "date": 1779722017137,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 674.1950366085455,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 778.6307277838246,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1312.6162711329837,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.103493901276956,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 630.6617643348815,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 455.2205267805761,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2884.959034128722,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2576.183368540321,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9288.504551365935,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5995.468824939313,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2655,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21617,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2496,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8210,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15377,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 703,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1570,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10868,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102427,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 515974,
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
          "id": "2101f54cb495a9ac1c60fbec0797c30f581d79d8",
          "message": "feat(protocol,server,openomni): add config-driven model and providerOptions override (#198)\n\n* feat(protocol,server): add model override to server config\n\nAllow config.json to specify model.provider, model.id, and\nmodel.providerOptions. resolveModel() prefers the explicit config\nover catalog auto-selection, enabling pinned model + reasoning\neffort without code changes.\n\n* feat(server): thread providerOptions through ingress bridge\n\nBridgeDeps accepts providerOptions and spreads it onto AgentDef.\nWorker runner forwards request.providerOptions to ChatAgent.create()\nso the AI SDK receives reasoning effort and similar settings.\n\n* feat(openomni): propagate providerOptions to agent execution\n\nbuildExecutionRequest() copies providerOptions from AgentDef into\nExecution.Request. ResidentRuntime.buildAgentConfig() reads the\npassthrough field and forwards it to ChatAgentConfig so both\nresident and worker paths honour the configured reasoning effort.",
          "timestamp": "2026-05-28T20:18:57+09:00",
          "tree_id": "b96f28fb29dc6a6dcfeebd1e1e94e4f66ac4652b",
          "url": "https://github.com/INONONO66/openomni/commit/2101f54cb495a9ac1c60fbec0797c30f581d79d8"
        },
        "date": 1779967164019,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 700.1947933733602,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 856.607589515103,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1302.0090749303388,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.93924044809387,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 621.8260518101217,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 442.56920877697377,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2803.477082223293,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2506.145377540718,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10148.345849401454,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5860.295417252295,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2356,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21193,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2395,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7862,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15126,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 743,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1623,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10882,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101657,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 513616,
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
          "id": "eac1bce0328ea285b2c09d8f33fbe600476d147d",
          "message": "feat(session): add SHA-256 hash chain for tamper-evident event log (#202)\n\n* feat(session): add SHA-256 hash chain for tamper-evident event log\n\nEach persisted bus event now includes prev_hash and event_hash columns\nforming a session-scoped hash chain. A separate append-only event_chain\ntable preserves integrity proofs even after CASCADE deletes on bus_event.\n\nBusQuery gains verifyChainIntegrity() to walk the chain and detect\ntampering, and listAuditChain() to read the durable audit trail.\n\n* refactor(session): squash migrations into single schema\n\nNo existing users so incremental migrations are unnecessary overhead.\nRemoves compatApplied/compatInsert from migration runner since there\nare no legacy compat scenarios to handle.\n\n* fix(session): address review feedback on hash chain\n\nWrap bus_event + event_chain inserts in a single transaction to\nprevent inconsistent state on partial failure. Make sessionId\noptional in verifyChainIntegrity to support sessionless events.\nDocument threat model limitations in hash utility.",
          "timestamp": "2026-05-30T02:24:36+09:00",
          "tree_id": "67e02f1c3329c8edd1fc18fda97e8b242a62d802",
          "url": "https://github.com/INONONO66/openomni/commit/eac1bce0328ea285b2c09d8f33fbe600476d147d"
        },
        "date": 1780075501517,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 949.9153741676352,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 816.8580063879117,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1389.2766007696632,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.59350652699947,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 675.631437064996,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 475.2656635411528,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2998.253920187116,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2659.3723107201295,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9724.367269543944,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6422.694367735404,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2449,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 26868,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2536,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8693,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 17316,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 765,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1603,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11601,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101874,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 519766,
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
          "id": "31197804cbdefdae133c626009b73f5451cf4aad",
          "message": "fix(llm): pass apiKey to proxy model discovery requests (#203)\n\nfetchProxyModels was calling the proxy /v1/models endpoint without\nAuthorization header, causing auth failures when the proxy requires\nAPI keys (PROXY_REQUIRE_API_KEY=true). The empty model list fallback\nthen hit the models.dev catalog where newer models like gpt-5.5 are\nabsent, producing 'Model not found' errors after 3 retries.",
          "timestamp": "2026-05-31T18:45:04+09:00",
          "tree_id": "13ef2b37c9dc8df6a46a84fcb7accdb01458b5e7",
          "url": "https://github.com/INONONO66/openomni/commit/31197804cbdefdae133c626009b73f5451cf4aad"
        },
        "date": 1780220727532,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 721.9394510382199,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 847.3986526564686,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1570.7252493520534,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.617347705937796,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 687.7601169188882,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.24002432976545,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3233.897972383107,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2606.148158765919,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9901.32940594003,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6176.1531002967495,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 3027,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 24269,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2380,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8214,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16126,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 813,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1600,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11084,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101276,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 507536,
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
          "id": "5bedf529cf11da093baa1d0de304d2ae9d1fd5aa",
          "message": "fix(agent): fallback to proxy model list when models.dev catalog misses (#204)\n\nresolveProviderModel only looked up models from the static models.dev\ncatalog. Proxy-only models (e.g. gpt-5.5) that exist in the proxy\n/v1/models endpoint but not in models.dev would fail with 'Model not\nfound'. Now falls back to Provider.listModels(provider, 'proxy') which\nqueries the proxy endpoint and returns stub models for uncataloged IDs.",
          "timestamp": "2026-05-31T23:29:33+09:00",
          "tree_id": "7df0d2624aa2f8a1cae75866971682cab352288a",
          "url": "https://github.com/INONONO66/openomni/commit/5bedf529cf11da093baa1d0de304d2ae9d1fd5aa"
        },
        "date": 1780237801393,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 726.8435115057938,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 935.9004482964692,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1320.4375371369333,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.058459296967825,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 605.6019500378133,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446.0703274154993,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2885.530528624108,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2512.066242966123,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9491.425398633344,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5964.594596207078,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2313,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20628,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2393,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8060,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15549,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 777,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1654,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10715,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101019,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 508425,
            "unit": "ns/op"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "inonono66@gmail.com",
            "name": "INONONO66",
            "username": "INONONO66"
          },
          "committer": {
            "email": "inonono66@gmail.com",
            "name": "INONONO66",
            "username": "INONONO66"
          },
          "distinct": false,
          "id": "e07970886669f9515f6fd5a8035492b2dd78f94e",
          "message": "fix(openomni): preserve scheduled worker targets",
          "timestamp": "2026-06-03T05:24:31+09:00",
          "tree_id": "3d0b89b650bc028056107c5f98feec78d0ced582",
          "url": "https://github.com/INONONO66/openomni/commit/e07970886669f9515f6fd5a8035492b2dd78f94e"
        },
        "date": 1780432234176,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 792.8355836391921,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 884.6922430419406,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1612.6646508631177,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 53.155153974430654,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 722.6299210891843,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 601.0609413786387,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3525.151884037701,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2721.3710506977804,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10952.67298214923,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6250.048437500049,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2142,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 22778,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2589,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8697,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16644,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 775,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1634,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11180,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 107001,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 538144,
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
          "id": "598998184e7c65c2bce13d954ab1f143f409e8b2",
          "message": "refactor(openomni,server): remove inbound_message shim (#208)\n\n* test(openomni,server): update tool assertions for dispatch\n\nDelete inbound_message shim tests. Update ingress-bridge and\nworker-runner assertions to expect dispatch in tool lists and\nprompt strings.\n\n* docs(openomni,server): replace inbound_message refs with dispatch\n\nUpdate worker prompt to reference dispatch with resident.deliver.\nUpdate all AGENTS.md docs to reflect dispatch as the cross-session\norchestration tool.",
          "timestamp": "2026-06-04T00:20:41+09:00",
          "tree_id": "a0784bd621ff18229094d4c5865e66d31e8554bf",
          "url": "https://github.com/INONONO66/openomni/commit/598998184e7c65c2bce13d954ab1f143f409e8b2"
        },
        "date": 1780500072626,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 736.206166440915,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 871.6058693814466,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1440.4780329003722,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.445641550189464,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 759.269038616276,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446.14817392548395,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3066.6862829285647,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2523.329590472178,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11169.311145856242,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6402.3454545453515,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2367,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20801,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2443,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8139,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15508,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 732,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1680,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10769,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 99743,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 512091,
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
          "id": "c2c456ee7c9199b95d06b217b9bbe1bf50552841",
          "message": "Unify communication egress through dispatch (#209)\n\n* feat(protocol): add communication dispatch contracts\n\n* feat(session): persist communication state\n\n* feat(openomni): gate egress through dispatch\n\n* feat(server): route worker asks through resident\n\n* test: clean dispatch verification baseline\n\n* fix: harden communication dispatch state",
          "timestamp": "2026-06-04T17:27:42+09:00",
          "tree_id": "f36f47a1026664aa09a3b36e6990606954edbfa0",
          "url": "https://github.com/INONONO66/openomni/commit/c2c456ee7c9199b95d06b217b9bbe1bf50552841"
        },
        "date": 1780561693308,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 759.8160716049213,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 824.3752802874861,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1426.1386337706206,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.25571616711787,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 650.0338845338653,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445.9963160852583,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3035.9689729497954,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2540.100434351851,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10143.176082767055,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5967.286293931214,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2376,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20943,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2575,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8323,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15992,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 760,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1636,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11014,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 109723,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 537957,
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
          "id": "7346fc31840b5f156aa1dcf73e56b9860ea89789",
          "message": "refactor: remove communication dispatch legacies\n\nRemove legacy communication dispatch fallback paths and stale inbound tool references.",
          "timestamp": "2026-06-05T02:03:21+09:00",
          "tree_id": "b034de78400599f75bfc98a2a125e91491d5e728",
          "url": "https://github.com/INONONO66/openomni/commit/7346fc31840b5f156aa1dcf73e56b9860ea89789"
        },
        "date": 1780592631010,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 703.958973348215,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 850.8363679678979,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1278.9033021279083,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.64491295274464,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 596.8776344612712,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 492.73338753390806,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2877.2517263207437,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2888.5895895315252,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9183.645881164894,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5859.748154224651,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2298,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20729,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2406,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7867,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15181,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 726,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1672,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10885,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103050,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 521569,
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
          "id": "b415bee0d92c7f0d4850abd4a3ab2b18a8158bd3",
          "message": "docs: accept ADR-009 and align project vocabulary (#211)\n\n* docs: align ADR-005 terminology with resident/worker\n\nRename ADR-005 from \"Persona Workforce Runtime Direction\" to\n\"Workforce Runtime Direction\". Replace \"Main Persona / Sub Persona\"\nwith the canonical product terms used in docs/core-model.md and\nroot AGENTS.md.\n\nAdd forward-reference to ADR-009 for the external actor authority\nmodel, executorKind, SessionOwner / SessionOrigin / SessionPurpose,\nand the uniform Worker abstraction across internal AI, external AI,\nand external humans.\n\nKeep a header note documenting the original title and term mapping\nso historical references in older changelogs remain readable.\n\n* docs: accept ADR-009 with scenarios and vocab map\n\nPromote ADR-009 (External Actor Authority & Communication Model) from\nProposed to Accepted after the design contract review.\n\nAdd three new top-level sections:\n\n- Scenarios — five end-to-end traces (owner DM, task outreach,\n  PI-matched reply, public-channel unsolicited, external-api worker)\n  that ground every decision in the body.\n- Vocabulary Map — the canonical seven-category cheat sheet\n  (subjects, identity, medium, message units, session/execution,\n  authority/lifecycle, module names).\n- Decisions Resolved — five open design points settled during the\n  review: actor.message-vs-actor.reply branching, ChannelGrant.kind\n  enum, unregistered endpoint promotion, ambiguous PendingInteraction\n  status handling, System Governor representation.\n\nClarify ChannelGrant.kind as a three-value enum (trusted_channel /\nbroadcast_channel / blocked_channel) refined by inboundTreatment.\n\nUpdate the inbound authority order consequence to attribute the\nprecedence to DispatchRuntime and clarify that EventProjector is\ninvoked dispatch-side after the final session is resolved (so a\nPI match can override the ingress candidate without persisting to\nthe wrong session).\n\n* docs: align core-model and AGENTS with new vocabulary\n\n- docs/core-model.md: expand the vocabulary table from 5 rows to a\n  seven-category cheat sheet matching ADR-009 (subjects, identity,\n  medium, message units, session/execution, authority/lifecycle,\n  module names). Add a \"How It Actually Works\" section that\n  describes the three-layer message flow (server channel adapter →\n  ingress → dispatch) with the invariant that adding a new channel\n  must only touch apps/server/.\n\n- AGENTS.md: expand the Product Model section with Owner, Actor,\n  lifecycle, ChannelGrant, Blacklist rows and a three-layer\n  message-flow table. Add WHERE TO LOOK rows for the planned\n  actor / channel-grant / blacklist / pending-interaction domains.\n  Note PendingAsk → PendingInteraction as a successor (not a pure\n  rename: status enum, allowedActions, followUpWindow, and\n  workerRunId/sessionId strong-coupling all change). Update the\n  intro to cite both ADR-005 and ADR-009 as accepted decisions.",
          "timestamp": "2026-06-08T14:47:17Z",
          "tree_id": "33420b555a279406383f0ba2504cf0a4f825fcd8",
          "url": "https://github.com/INONONO66/openomni/commit/b415bee0d92c7f0d4850abd4a3ab2b18a8158bd3"
        },
        "date": 1780930067693,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 734.2752131228671,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 949.8390877745353,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1394.4478825319018,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 53.13130389508154,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 663.8895225324011,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 504.34788375789657,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3254.663477185705,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2675.7796805182575,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10176.53892337408,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6229.23869440598,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2200,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19816,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2611,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8631,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16444,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 726,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1591,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11202,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 107259,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 542155,
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
          "id": "862e00f6f0b02d5e3d7c93ea3c6b8144d331cad6",
          "message": "docs: Agent OS model (ADR-010~013) + doc-code alignment (#212)\n\n* docs: add ADR-010 agent OS kernel model and implementation status ledger\n\nADR-010 (proposed) names the organizing architecture: kernel/userland\nsplit, PendingInteraction as the blocking-wait primitive, CLI agents as\ninstalled applications with a connector contract, three execution lanes\nwith the effect-radius rule, the WorkItem task ledger with completion\nreports and the evidence gate, the Governor as an incident-driven\npostmortem engine, a pluggable memory engine port (Hermes pattern), a\ndurable boot contract, and a social-budget axis.\n\nimplementation-status.md is the single source of truth for the gap\nbetween accepted design and running code (implemented / dormant /\npartial / planned), so design docs can describe targets without\noverclaiming.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* docs: align project docs with implementation reality and ADR-010\n\n- core-model: split 'How It Actually Works' into current vs target with\n  per-component status, add execution lanes table, completion-report\n  writeback unit, Governor two-loop summary, memory port summary, and an\n  honest note on the Resident's current full toolset\n- ADR-008: Proposed -> Accepted (OnDemandWorkerManager and\n  ResidentRuntime verified shipped; legacy pool removal pending)\n- ADR index: register ADR-010, update 007/008 statuses and evolution\n- AGENTS.md: remove unimplemented ActorResolver present-tense claims,\n  reflect worker-manager vs legacy pool, point to implementation-status\n  as the source of truth for what is wired\n- README: honest current status with implementation-status pointer\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* docs: graduate ADR-010 sections into ADR-011/012/013\n\nADR-010 had grown into a decision-record/spec hybrid (the ADR-006\nfailure mode). Its three matured sections graduate into focused records:\n\n- ADR-011: task ledger, completion reports, and the evidence gate\n  (no evidence = not done; three-question verification; per-executor\n  retry with kernel-enforced exhaustion; read-back verification)\n- ADR-012: Governor as incident-driven postmortem engine (two loops,\n  incident lanes, storm collapse, cause taxonomy, tighten-autonomous/\n  loosen-approval, ratchet through the same RCA pipeline, fingerprints)\n- ADR-013: built-in memory plus pluggable Memory.Engine port (Hermes\n  pattern; kernel-side mandatory scope filter; candidate stream)\n\nADR-010 keeps the kernel model core and gains an end-to-end scenario\ntrace (marketplace inquiry) grounding all mechanisms. Cross-references\nin core-model and implementation-status updated; vocabulary gains the\ntask-and-improvement category.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* docs: add owner usage model and polish doc surface\n\n- docs/usage-model.md: the system from the Owner's seat — mental model,\n  lanes as felt behavior, the four inbound message kinds, task manager\n  view, correction-as-signal, autonomy arc, and the two promises\n- README: further reading now spans usage model, ADR-010-013, and\n  implementation status\n- design-philosophy: principle 2 points to its ADR-010 kernel/userland\n  concretization\n- AGENTS.md: ADR-010-013 framing + usage-model lookup row\n- .gitignore: exclude .codegraph (generated index)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-11T16:29:20+09:00",
          "tree_id": "b85c08847cd903594a0f999753db008f140dce5c",
          "url": "https://github.com/INONONO66/openomni/commit/862e00f6f0b02d5e3d7c93ea3c6b8144d331cad6"
        },
        "date": 1781162986251,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 766.7829100724271,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 835.8018655033467,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1609.9750615813493,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 53.281753628604086,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 615.5286282331339,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 599.0205043727703,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2689.3024337769557,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2753.4603502394725,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8492.695711252609,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6301.997857322076,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2072,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19425,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2501,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8476,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16003,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 742,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1605,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 12120,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 107201,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 567341,
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
          "id": "afcfb789fada753ecf357a95c5f82e1aaa0d3550",
          "message": "docs(coordinator): refresh stale AGENTS.md to current module reality (#223)\n\n83 commits stale (threshold 50, flagged by check-deps). Updates:\n- worker-manager/ documented as the live primary API (OnDemandWorkerManager,\n  slots, idle shutdown, waiter queue); worker-pool/pool.ts marked as legacy\n  facade pending removal\n- worker lifecycle, live consumer (apps/server execution coordinator),\n  barrel export surface, and test layout documented\n- anti-pattern added: do not build on the legacy pool facade\n\nRefs #189 (residual Track C item), #216\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-11T10:26:09Z",
          "tree_id": "d947cf52c4d69a5218a34fce165a345d4c0b848a",
          "url": "https://github.com/INONONO66/openomni/commit/afcfb789fada753ecf357a95c5f82e1aaa0d3550"
        },
        "date": 1781173595108,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 740.3053375777512,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 847.4940294080732,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1372.7695961341544,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 52.74215526533865,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 654.8696039396096,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 587.7572102808991,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2899.675800278428,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2723.8145666499036,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9147.999451152364,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6257.304029533801,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2138,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19868,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2543,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8443,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16009,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 773,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1675,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11216,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 107956,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 538763,
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
          "id": "75af8726e7bf520d61f71768be297e49a136c616",
          "message": "docs: Agent OS qualification — definition, litmus tests, bets, kill criteria (#224)\n\n* docs: define the Agent OS category — five duties, five litmus tests\n\nFunctional definition with the metaphor stripped: multiplexing,\nprotection-by-mechanism, stable ABI, lifecycle, third-party programs —\ntranslated to agent-world resources (money, context, the principal's\nauthority, real-world time) plus the category's genuinely new duty:\ntruth, because agents can lie about their exit codes and CPUs cannot.\n\nIncludes the T1-T5 litmus tests that turn 'is it an Agent OS' into an\ninspection, a scored landscape (frameworks, durable schedulers, Claude\nCode, OpenClaw, Hermes, AIOS), and OpenOmni's own honest scorecard:\n0.5/5 today, ~4/5 on the designed path, with issue refs per test.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* docs: record standing criticisms, falsifiable bets, and kill criteria\n\nApplies 'evidence over self-report' to the project itself: nine\nstanding criticisms kept un-refuted (one-app kernel, convention-not-\nmechanism, await-world novelty, statistical anemia, RCA confabulation\nand policy ossification, injection surface, cheap control group,\nmetaphor cosplay, self-serving definition), three measurable bets with\npre-committed kill criteria (H1 reply correlation >=70%, H2 declining\nunplanned interventions, H3 Governor net-positive 3:1 without\nthroughput loss), checkpoint cadence (C1 = #213 merge, the dormant-\nengine pattern test), and the current verdict: design A, running\nsystem D+, deciding variable = our own wiring conversion rate.\n\nREADME: link both docs from Further Reading.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-11T13:07:04Z",
          "tree_id": "1849cffdb9fc1788ef3b14ec42c5eb03fafaa943",
          "url": "https://github.com/INONONO66/openomni/commit/75af8726e7bf520d61f71768be297e49a136c616"
        },
        "date": 1781183256560,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 709.6342411897224,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 832.5659181921949,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1350.319272471549,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.390580652747985,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 597.9670342155042,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 444.17671984930547,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2737.22113647537,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2488.406001940587,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9139.322701516889,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5885.2843691150265,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2265,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20195,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2311,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7927,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14965,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 705,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1596,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10859,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102195,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 512508,
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
          "id": "b58a9f2334cea4fcc73ca1a540b4fd27bb43045a",
          "message": "docs: adopt connector definitions as the public install ABI (#225)\n\nADR-010 §3 'Installation' subsection. Installing an app = installing\nits connector (a printer driver, not a printer; binaries stay with\nbrew/bun). The AppConnector definition is declarative Zod data —\ndetect/testedVersions, headless spawn, log parsing, question-bridge\nmaterialization, evidence kinds, required credentials/capabilities,\nrouting profile — so third parties integrate by writing one file,\nnever touching the kernel (the T1 third-party test, passed as an OS\nrather than as a framework).\n\nLifecycle: discover -> register -> consent (the app-store moment; the\nOwner's tap sets the permission ceiling, autonomy then grows only via\nledger evidence) -> wire -> smoke-verify ('installed' is itself an\nevidence-gated claim). Version drift outside testedVersions is an\nincident riding the ADR-012 pipeline. Scope guard: executor apps only;\nan app store before three working connectors is metaphor cosplay.\n\nimplementation-status: AppConnector schema + install lifecycle rows.\n\nRefs #216\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-11T14:05:26Z",
          "tree_id": "25cb11401b6292b61205698f18bafbe433d17893",
          "url": "https://github.com/INONONO66/openomni/commit/b58a9f2334cea4fcc73ca1a540b4fd27bb43045a"
        },
        "date": 1781186754109,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 717.3728389215875,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 804.6651244005247,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1401.20300414722,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.98421612730486,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 600.2696167882901,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 451.29839834277317,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2816.2140302457965,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2494.902724414858,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9754.595981272796,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5878.435516106692,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2249,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20208,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2416,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7821,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15284,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 820,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1595,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11143,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104671,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 541928,
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
          "id": "7d533e8d11bf6f8f31de4a038e16b60dedbf64bd",
          "message": "fix(session): count actual events per run in getWorkerRunHistory (#227)",
          "timestamp": "2026-06-12T00:36:47+09:00",
          "tree_id": "41bca90155b91b799ecf470cc78d5eaa351050e3",
          "url": "https://github.com/INONONO66/openomni/commit/7d533e8d11bf6f8f31de4a038e16b60dedbf64bd"
        },
        "date": 1781192236285,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 768.6522006487352,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 879.0630373250104,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1518.3342291454844,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.5184601978366,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 688.7111137129654,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 454.4911169993523,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3340.21022746242,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 3195.5169041989507,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 12104.20067780178,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5992.450263662283,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2374,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20892,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2886,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8187,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15773,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 730,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1586,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11148,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 105310,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 525197,
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
          "id": "6034b55e8667946a1b7600a925593db1035d2864",
          "message": "refactor(coordinator): remove legacy worker pool facade\n\nRemoves the legacy createWorkerPool facade, preserves worker-manager behavior, and updates implementation-status as the SSOT.",
          "timestamp": "2026-06-12T01:40:29+09:00",
          "tree_id": "b9901e79f27798a947bcd945f68f20077e6b3da0",
          "url": "https://github.com/INONONO66/openomni/commit/6034b55e8667946a1b7600a925593db1035d2864"
        },
        "date": 1781196065912,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 749.9946225672678,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 864.1554960251337,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1407.8758394456943,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.624958563138684,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 709.7659128977429,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 444.0064425322933,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3042.976478105718,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2603.6774890647957,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10998.710954685295,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6183.074687770335,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2400,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19206,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2501,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8304,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16469,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 792,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1520,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10837,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101031,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 504469,
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
          "id": "5057d996d838c72e50b3f7a909ffa70de9e65124",
          "message": "feat(openomni): persist scheduled cron jobs (#229)",
          "timestamp": "2026-06-12T02:30:46+09:00",
          "tree_id": "43735528b8fb96397d189a3e840f8fd49217f963",
          "url": "https://github.com/INONONO66/openomni/commit/5057d996d838c72e50b3f7a909ffa70de9e65124"
        },
        "date": 1781199078713,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 686.170684177739,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 797.2003364185202,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1426.6466224409694,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.87017430550432,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 581.8758226220683,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 442.0661462086387,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2652.20297042822,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2702.8603438024834,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8580.562505362579,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5941.087571292711,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2229,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20385,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2323,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7901,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14829,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 730,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1590,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10865,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103318,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 521598,
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
          "id": "75bc4f0e57c2327046b9da4209531ba9ec98f9ac",
          "message": "feat(openomni): start durable cron runner at boot (#230)",
          "timestamp": "2026-06-12T03:20:19+09:00",
          "tree_id": "ada50dac5af8f8e21a2ddab7577f380fd6f93139",
          "url": "https://github.com/INONONO66/openomni/commit/75bc4f0e57c2327046b9da4209531ba9ec98f9ac"
        },
        "date": 1781202048864,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 910.8955484910437,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 892.7963538318083,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1585.7887763674016,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.749051907764674,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 784.0713109612949,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 480.68006479547483,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3403.7006126615993,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 3166.2254939209824,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10185.524546751085,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6424.874333440191,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2276,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20325,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2514,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8545,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16464,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 805,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1579,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11036,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103336,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 550039,
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
          "id": "bb1b8c9e861083a893ddc7bc031499192452d6be",
          "message": "docs(openomni): align cron runner package docs (#231)",
          "timestamp": "2026-06-12T03:25:25+09:00",
          "tree_id": "49e39accab3de11b8dba0bf0d3973c28026ce7ba",
          "url": "https://github.com/INONONO66/openomni/commit/bb1b8c9e861083a893ddc7bc031499192452d6be"
        },
        "date": 1781202363098,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 707.6909764442855,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 798.2981711062544,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1306.6320410807225,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 48.32339450430228,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 639.0884753280098,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 575.4429163309991,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2809.892298182611,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2673.9074574189094,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9143.653927036072,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6226.138152160154,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2140,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19615,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2566,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8842,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16356,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 721,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1557,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11340,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 106715,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 541411,
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
          "id": "7b0c8c1246e9235d4bd4fa01b2038437027ade92",
          "message": "feat(openomni): create work items for worker spawns\n\n## Summary\n- Wire worker.spawn to create and start WorkItem ledger entries.\n- Return workItemHash from spawn output for durable work correlation.\n- Preserve coordinator thrown errors and terminal results when ledger reflection writes fail.\n- Mark WorkItemStore as wired in implementation-status while keeping completion-report gates pending.\n\n## Validation\n- LSP diagnostics clean on changed TS files\n- bunx biome check --write packages/openomni/src/dispatch/handlers/worker.ts packages/openomni/test/dispatch/handlers.test.ts docs/implementation-status.md\n- bun test packages/openomni/test/dispatch/handlers.test.ts\n- bun run check-types\n- bun run build && bun test && bun run test\n- Manual runtime QA: worker.spawn persisted a WorkItem and returned matching workItemHash\n- OMO verifier PASS\n- Claude Fable 5 PASS\n- GitHub Actions PASS\n- CodeRabbit/Cubic review feedback addressed",
          "timestamp": "2026-06-12T10:42:44+09:00",
          "tree_id": "4efb5bf98a2f2bd1b4920d33fc3db959027a7d72",
          "url": "https://github.com/INONONO66/openomni/commit/7b0c8c1246e9235d4bd4fa01b2038437027ade92"
        },
        "date": 1781228596076,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 722.715886013222,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 827.5361094331554,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1384.2378810109271,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.15638987755509,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 630.0280400914345,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445.78299884984017,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2868.858683802966,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2514.494342469248,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10092.114441416845,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5945.6599678936345,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2973,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21747,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2442,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8089,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15298,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 734,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1686,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11218,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103773,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 547096,
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
          "id": "7728d0523af18694757b1dddae834845e91d658d",
          "message": "fix(coordinator): route worker affinity through SessionRouting (#233)",
          "timestamp": "2026-06-12T11:08:25+09:00",
          "tree_id": "7b6d34a11e4f38fd1ad2bde16c25925bd0b9ea4e",
          "url": "https://github.com/INONONO66/openomni/commit/7728d0523af18694757b1dddae834845e91d658d"
        },
        "date": 1781230131572,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 764.9205479871454,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 1044.2779732877414,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1409.8631345953715,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 48.77875519554309,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 661.2278588148686,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 549.0132696477342,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2967.912773787241,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2695.0978304809223,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10272.48217770947,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6318.942689245681,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2648,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19615,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2491,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8467,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16187,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 729,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1881,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11622,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 109336,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 539330,
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
          "id": "5a8d4b8924ab004d99560fe39030c42cc0a908a2",
          "message": "feat(server): wire BusQuery observability endpoint (#234)",
          "timestamp": "2026-06-12T11:45:14+09:00",
          "tree_id": "8f4545dbf148d62dac8658c08005e7632e8198ac",
          "url": "https://github.com/INONONO66/openomni/commit/5a8d4b8924ab004d99560fe39030c42cc0a908a2"
        },
        "date": 1781232343483,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 701.3840618337172,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 789.9851957184491,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1361.0072677780443,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.898943190431034,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 637.9570082487767,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446.51230141351317,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2806.4509864447714,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2575.3462528967993,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9320.808742659878,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6137.238492696381,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2335,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19130,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2433,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 11510,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 18000,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 744,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1522,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10958,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101989,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 539825,
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
          "id": "6c367f026f8a0839793a596ddf86fbc986a0c103",
          "message": "feat(server): add open task ledger command\n\nAdds an authenticated WebSocket task-ledger command backed by WorkItemStore, with compact deterministic output and auth-gated tests.",
          "timestamp": "2026-06-12T13:13:23+09:00",
          "tree_id": "7cd1dfea91039edddb219a156c14211515b07cdf",
          "url": "https://github.com/INONONO66/openomni/commit/6c367f026f8a0839793a596ddf86fbc986a0c103"
        },
        "date": 1781237627220,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 737.1326099615734,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 830.1048336889356,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1321.2488967577374,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.08073259471846,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 655.1132030974096,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448.6828491307334,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2851.478272026874,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2495.288327178535,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9347.646382501438,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5853.4036289141795,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2579,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20810,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2381,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7941,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15229,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 690,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1612,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10861,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102718,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 517995,
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
          "id": "ae78f1c3bf18bc85bba8b370730a797edb4f7be4",
          "message": "feat(openomni): require worker spawn acceptance criteria\n\nRequire worker.spawn payloads to include acceptance criteria before dispatching or creating WorkItems. Persist acceptance criteria and constraints on WorkItems, harden spawned identity handling, and clarify payload validation errors.",
          "timestamp": "2026-06-12T14:31:57+09:00",
          "tree_id": "271970c340effe7d2b9062507dbc430c2faeebd8",
          "url": "https://github.com/INONONO66/openomni/commit/ae78f1c3bf18bc85bba8b370730a797edb4f7be4"
        },
        "date": 1781242340994,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 774.1008414420778,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 842.8311138828421,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1537.0359969874999,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.90919122659334,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 748.0060962383282,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 449.49176532989094,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3159.0936344964603,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2623.632621471566,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10500.145107097713,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6184.02318966058,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2527,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20554,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2542,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8595,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16235,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 768,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1519,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10812,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103823,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 528469,
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
          "id": "1b7f196d7c42229d3a4977568219e83876e581aa",
          "message": "refactor(openomni): use croner for cron schedules",
          "timestamp": "2026-06-12T15:03:48+09:00",
          "tree_id": "d30662c3ebc46a1418966f93578606af68cac894",
          "url": "https://github.com/INONONO66/openomni/commit/1b7f196d7c42229d3a4977568219e83876e581aa"
        },
        "date": 1781244253381,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 716.2228087264282,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 812.1853563451591,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1302.751761962427,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.35771497201231,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 656.8066757743746,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450.5790400922481,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3133.5266819163394,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2525.9011871686967,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10080.722681451705,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5856.803982430403,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2295,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20610,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2348,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7996,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15365,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 751,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1595,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10820,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102781,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 513259,
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
          "id": "3facd31e2df7b51551e34cebaae78222d2e699a2",
          "message": "feat(protocol): add app connector schema",
          "timestamp": "2026-06-12T15:56:35+09:00",
          "tree_id": "0b1bf990beef7135c0360e8d945b27fcef002ffb",
          "url": "https://github.com/INONONO66/openomni/commit/3facd31e2df7b51551e34cebaae78222d2e699a2"
        },
        "date": 1781247425135,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 745.675028149113,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 847.8666655361164,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1407.6777308557766,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.97045699425766,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 644.8510343316528,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 452.2193621909755,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3042.6124075821313,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2495.1629572333777,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10326.385274678396,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5862.313969165921,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2765,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21297,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2455,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8075,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15474,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 736,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1606,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10911,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103239,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 518299,
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
          "id": "53d572b58f03017bd7f2e6dc4ab38aed79fb52e5",
          "message": "feat(protocol): add work item schema deltas (#239)",
          "timestamp": "2026-06-12T16:13:08+09:00",
          "tree_id": "1aba848423741b87d5cc7356702263b17ff6735d",
          "url": "https://github.com/INONONO66/openomni/commit/53d572b58f03017bd7f2e6dc4ab38aed79fb52e5"
        },
        "date": 1781248417879,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 690.4371081774688,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 796.7754370310064,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1255.3894824059826,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.851139419622484,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 589.8908997599549,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.05616802113906,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2864.483314714847,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2767.3157151946552,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10035.321625690267,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5889.800223805817,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2288,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 22367,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2484,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8607,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15009,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 715,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1596,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10708,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101804,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 511104,
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
          "id": "09f649a9c621fea8ee37575050ccced58bc0ba35",
          "message": "feat(openomni): gate worker completion reports (#240)",
          "timestamp": "2026-06-12T16:39:35+09:00",
          "tree_id": "2074c9e512a051e46d2e290719f9c571f6704005",
          "url": "https://github.com/INONONO66/openomni/commit/09f649a9c621fea8ee37575050ccced58bc0ba35"
        },
        "date": 1781250000750,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 738.3693016525435,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 900.341589462424,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1399.757618174693,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 48.13325786043569,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 626.8867470332484,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 454.1743338434236,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3137.68802359535,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2628.219243607054,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9883.76042696169,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5859.047515818454,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2580,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20843,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2553,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8138,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15222,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 708,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1569,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10973,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103120,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 527358,
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
          "id": "1e42dd68bb06999ac6e0e9b537388bbc80e1c887",
          "message": "feat(session): add read-back evidence records (#241)",
          "timestamp": "2026-06-12T17:03:23+09:00",
          "tree_id": "d174b40fdb6e1ab08547fed1df125ac863c4fe33",
          "url": "https://github.com/INONONO66/openomni/commit/1e42dd68bb06999ac6e0e9b537388bbc80e1c887"
        },
        "date": 1781251433074,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 941.7013739135521,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 846.7408467400701,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1317.2817925544705,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.23243041809899,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 665.2308546871647,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 451.8471402622266,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3114.645342136839,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 3389.0338563734344,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10002.467393477964,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5852.229810393303,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2325,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20156,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2464,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7994,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15201,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 715,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1693,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10990,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102445,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 517023,
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
          "id": "adbfcb77e6e87304b59913ddab7b23b1c93d0689",
          "message": "feat(session): gate exhausted work item retries (#242)",
          "timestamp": "2026-06-12T17:32:34+09:00",
          "tree_id": "e26f0af6d7286dc2370e3dcd005acbc14f82cbe6",
          "url": "https://github.com/INONONO66/openomni/commit/adbfcb77e6e87304b59913ddab7b23b1c93d0689"
        },
        "date": 1781253180875,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 717.1170400436425,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 822.9888321028691,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1280.7912829642992,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.85466063171907,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 586.792926803487,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446.1333621830872,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2680.8504637818273,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2467.865625231174,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9426.492129324191,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5834.078058456651,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2241,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20021,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2333,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7826,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14926,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 739,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1671,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10671,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101143,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 507311,
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
          "id": "87da74e872d94050c6b4d1acf9013b79ef2d1033",
          "message": "feat(openomni): add runtime read-back executor (#243)\n\nRuntime read-back executor for SSOT evidence checks.",
          "timestamp": "2026-06-12T18:27:34+09:00",
          "tree_id": "61557f8d5024b54675212cf7985c24c0450b95dc",
          "url": "https://github.com/INONONO66/openomni/commit/87da74e872d94050c6b4d1acf9013b79ef2d1033"
        },
        "date": 1781256481126,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 870.7800505051164,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 856.3334903276296,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1419.125448791469,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.208969041308094,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 602.1777316110897,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 449.8946530199326,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2738.2366374588532,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2497.276196184552,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9034.868009756534,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5907.642131380397,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2218,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20284,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2432,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8466,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15375,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 721,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1772,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11129,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103315,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 542381,
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
          "id": "6e7678fe4aff1f02e3c8f42a6fc96b6b32d8b464",
          "message": "feat(openomni): invoke read-back during completion gate\n\nWires bounded read-back execution into worker completion reflection, attaches read-back evidence to completion claims, and updates implementation status. Includes completion-gate hardening from review: request caps, shared envelope deadline, fractional timeout rounding, default body cap, and post-await deadline recheck.",
          "timestamp": "2026-06-12T19:37:23+09:00",
          "tree_id": "67573e3801f72c25fbe476a351e63707d2305b6f",
          "url": "https://github.com/INONONO66/openomni/commit/6e7678fe4aff1f02e3c8f42a6fc96b6b32d8b464"
        },
        "date": 1781260670435,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 722.1923260248379,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 869.7125463112708,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1529.7683988312817,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.112497065527556,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 658.602435506508,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 457.4671973283603,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2881.3031088831917,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2510.8069950785257,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10915.89629952994,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5886.31073047217,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2230,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20650,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2403,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8168,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15589,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 720,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1585,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11499,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102044,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 538935,
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
          "id": "8a3dbc22c63a2b600b968010d18f32172a1389f8",
          "message": "feat(server): surface retry exhaustion in task ledger",
          "timestamp": "2026-06-12T20:00:31+09:00",
          "tree_id": "7ecafa3d93ff0711f0c63000f48c6582ff7160a7",
          "url": "https://github.com/INONONO66/openomni/commit/8a3dbc22c63a2b600b968010d18f32172a1389f8"
        },
        "date": 1781262063258,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 684.9182345569038,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 819.2496989256591,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1308.6788504575238,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.057237589978456,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 602.7737130801798,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 443.6897192778558,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2679.066948857697,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2512.4571378319847,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8933.949526532373,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5890.6459916350705,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2318,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19980,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2337,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7919,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15197,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 744,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1716,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10850,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102697,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 513908,
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
          "id": "18916dc25de9c2d5057cac9d50f63bbcc440af1e",
          "message": "feat(session): record owner work item outcomes",
          "timestamp": "2026-06-12T20:14:22+09:00",
          "tree_id": "925c00a16f4fdc027a9335942b969eadde67f132",
          "url": "https://github.com/INONONO66/openomni/commit/18916dc25de9c2d5057cac9d50f63bbcc440af1e"
        },
        "date": 1781262887133,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 764.0870365841979,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 821.7909373304853,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1833.4996978963002,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.44741136768847,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 739.1490564782713,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 470.7694321129274,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3162.5982289692047,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2609.5526851412214,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10227.838412762687,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6185.928863044767,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2503,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19909,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2498,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8241,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15876,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 768,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1541,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10673,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 107029,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 528198,
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
          "id": "2aadf42a5a0c472a69e1f34f6645f64f743c84c8",
          "message": "feat(session): persist worker run executor kind",
          "timestamp": "2026-06-12T20:46:44+09:00",
          "tree_id": "9567b0439233b0c016189a3350c12131f8ae4f93",
          "url": "https://github.com/INONONO66/openomni/commit/2aadf42a5a0c472a69e1f34f6645f64f743c84c8"
        },
        "date": 1781264839177,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 740.9932569615778,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 834.0022101014096,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1423.0520691031468,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.578366329775804,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 651.5031728038866,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 503.85569607487287,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2976.8176367576666,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2618.3594637759793,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9812.257947409622,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6844.306139209892,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2074,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19499,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2548,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8509,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16316,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 751,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1598,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11353,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 106692,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 547641,
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
          "id": "6e085b125ea969445ba3ef8a99ed31f8ad13a51f",
          "message": "feat(openomni): resolve registered actor endpoints (#248)\n\n* feat(openomni): resolve registered actor endpoints\n\n* fix(openomni): scope actor endpoint resolution",
          "timestamp": "2026-06-12T22:31:49+09:00",
          "tree_id": "0c6fe2c87eae95255bb9ee5ee34955f3d73272c9",
          "url": "https://github.com/INONONO66/openomni/commit/6e085b125ea969445ba3ef8a99ed31f8ad13a51f"
        },
        "date": 1781271137125,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 686.6266277979523,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 808.72219616368,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1356.2464127810185,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.32676942883281,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 697.2209486358266,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 495.0756225556164,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2988.583462547808,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2761.321027198989,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9071.144684325356,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5930.14671173595,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2579,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21132,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2457,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7838,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14957,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 704,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1882,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10766,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101685,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 517214,
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
          "id": "adcdd0e62d74e4174d2e9fe0129bc9afb7480300",
          "message": "feat(openomni): enforce actor blacklist gate (#249)",
          "timestamp": "2026-06-12T22:58:01+09:00",
          "tree_id": "30a4e2f5e3e0671fbd097bb25245d91e3218ed20",
          "url": "https://github.com/INONONO66/openomni/commit/adcdd0e62d74e4174d2e9fe0129bc9afb7480300"
        },
        "date": 1781272711455,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 740.0158214499105,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 852.9555271238972,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1421.2656158954974,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.09835452520434,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 652.2490004369874,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450.0325192275096,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3188.992601569347,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2529.6109986847005,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10148.679926933684,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5879.007760141369,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2295,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20658,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2399,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8139,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15361,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 699,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1567,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10907,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103002,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 529185,
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
          "id": "6e1a2d0bd7f317134e67e5c131adaab795bd116e",
          "message": "feat(openomni): enforce channel grants on ingress (#250)\n\n* feat(openomni): enforce channel grants on ingress\n\n* test(server): seed channel grant fixtures",
          "timestamp": "2026-06-12T23:35:07+09:00",
          "tree_id": "e2f8e95c55abd742583b6f0ce07f4446b0ef931a",
          "url": "https://github.com/INONONO66/openomni/commit/6e1a2d0bd7f317134e67e5c131adaab795bd116e"
        },
        "date": 1781274932861,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 747.5990490572857,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 877.437101317267,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1521.9903202239764,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.84821418782284,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 725.8542923299243,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.64469631864193,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3079.762095408258,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2633.761647659955,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11283.659934559622,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6215.19378496009,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2502,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19860,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2501,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8498,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16322,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 760,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1518,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10851,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103547,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 528772,
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
          "id": "06374317cca3dfe698ef39b5a398ce6870a7443a",
          "message": "feat(openomni): implement canonical trust tier evaluation (#251)",
          "timestamp": "2026-06-13T00:02:06+09:00",
          "tree_id": "6c101860eeb17767e695571489faeaa0b5f54b39",
          "url": "https://github.com/INONONO66/openomni/commit/06374317cca3dfe698ef39b5a398ce6870a7443a"
        },
        "date": 1781276559507,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 722.6436577277447,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 844.3249014261626,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1421.3108388527835,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.35587977480363,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 664.5801583029875,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 442.4058760292777,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2966.9400682390788,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2494.3800853061916,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9775.389247312381,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6428.89694631932,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2596,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 22773,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2478,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8202,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15588,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 699,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1599,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10850,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102632,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 515224,
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
          "id": "5adb6c9e9ba304f484ce5e3828339b2a6a1084df",
          "message": "feat(openomni): record effective authority axes (#252)",
          "timestamp": "2026-06-13T00:22:01+09:00",
          "tree_id": "7d80765680cc6686ff9eceba71bab0afdffc9aee",
          "url": "https://github.com/INONONO66/openomni/commit/5adb6c9e9ba304f484ce5e3828339b2a6a1084df"
        },
        "date": 1781277746336,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 708.2020282855345,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 808.2667027691905,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1361.0679714719563,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.194225882804105,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 633.5558286872238,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 451.2860295412067,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3435.0255908216477,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2531.36899126725,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9614.986732045978,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6391.332140346891,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2354,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20640,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2406,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7963,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15287,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 693,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1609,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10960,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104345,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 520556,
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
          "id": "19ce6ae51927638558be5ff06d3b81fbf21d8f96",
          "message": "feat(session): add pending interaction store (#253)",
          "timestamp": "2026-06-13T00:41:22+09:00",
          "tree_id": "1a7f650b86c2e10d215e233a7b297e88c129d527",
          "url": "https://github.com/INONONO66/openomni/commit/19ce6ae51927638558be5ff06d3b81fbf21d8f96"
        },
        "date": 1781278914795,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 704.5589961460785,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 800.302409706106,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1257.7673131587444,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.04889696237599,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 596.5649507537962,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445.9940147801573,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2736.1866586408078,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2500.25372537279,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8578.767607446503,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5839.829829479017,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2230,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20229,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2381,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7868,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14772,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 735,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1593,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10759,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101382,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 515057,
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
          "id": "bc46a4ddba1b2771cb2971de468ec9e28b17ff0d",
          "message": "Route PendingInteraction replies through dispatch\n\nAdds structured dispatch correlation and routes matching PendingInteraction actor.message replies to the owning worker run/session as actor.reply. Locks fail-closed behavior for unmatched/disallowed replies, blacklist matches, and forged actor.reply labels.",
          "timestamp": "2026-06-13T01:03:23+09:00",
          "tree_id": "2f8082810e4defef01c0b832e1be61a581826d10",
          "url": "https://github.com/INONONO66/openomni/commit/bc46a4ddba1b2771cb2971de468ec9e28b17ff0d"
        },
        "date": 1781280233383,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 767.6771350708771,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 875.2004883556286,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1415.794526560346,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.21206995127248,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 650.908053009799,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 475.1706327332987,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2994.1441061108917,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2518.766006750491,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10182.883718561883,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5940.684923370493,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2631,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20895,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2473,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8005,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16834,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 720,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1592,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 12073,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102277,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 518941,
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
          "id": "5f032ffe950d62abd354a1c6bf966c489a2dd56e",
          "message": "feat(server): wire PendingInteraction channel wakeups\n\nRoute channel replies through Dispatch-owned PendingInteraction wake-up handling.",
          "timestamp": "2026-06-13T01:25:57+09:00",
          "tree_id": "cc8d00346181544b2b9dbb9b039d02e65e7c48aa",
          "url": "https://github.com/INONONO66/openomni/commit/5f032ffe950d62abd354a1c6bf966c489a2dd56e"
        },
        "date": 1781281585598,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 738.898616047328,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 843.1182297990347,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1390.1761336778188,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 55.34764124990063,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 734.8625451017766,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 557.7715648269669,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2976.200297618809,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2697.989343046105,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11443.264302058828,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6788.604846922069,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2495,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 22351,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2590,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8647,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16508,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 793,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1581,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11737,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 109342,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 553454,
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
          "id": "50a60629d3a564912ba121863266ef23473a3dc6",
          "message": "Restore PendingInteraction state during boot\n\nExpire stale PendingInteractions during boot recovery before inbound surfaces start.",
          "timestamp": "2026-06-13T01:49:23+09:00",
          "tree_id": "c8e0749cc60605326c9dcb07454795edeb3c144b",
          "url": "https://github.com/INONONO66/openomni/commit/50a60629d3a564912ba121863266ef23473a3dc6"
        },
        "date": 1781282993831,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 750.2522338676953,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 875.4730879676032,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1496.585432287549,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 48.42753860766725,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 652.5594187009067,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 457.2839132443182,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3172.71788445083,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2606.003830818655,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10156.603493804536,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6151.38020545018,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2314,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 22249,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2431,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8185,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15313,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 713,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1947,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11030,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 106945,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 523586,
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
          "id": "53fdb7cedd4be93fd90286cfa93dd2aad1ba9b30",
          "message": "feat(openomni): preserve worker executor kind\n\nAdds worker executorKind as the SSOT dispatch selector, preserves it through the dispatch tool/runtime path, and fail-closes unsupported non-internal executors with WorkItem ledger evidence.",
          "timestamp": "2026-06-13T02:39:17+09:00",
          "tree_id": "e5ef0a7c6675494d16a96f324b2fccee7ee799e9",
          "url": "https://github.com/INONONO66/openomni/commit/53fdb7cedd4be93fd90286cfa93dd2aad1ba9b30"
        },
        "date": 1781285981943,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 736.6455439580627,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 852.0335358319895,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1470.24672880731,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.594943796427025,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 668.8842037671023,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 472.67828191408995,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2928.383964391545,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2627.394051653939,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10103.513740149645,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6259.198848343614,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2509,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19642,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2476,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8876,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15913,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 820,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1646,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10917,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102505,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 537049,
            "unit": "ns/op"
          }
        ]
      }
    ]
  }
}