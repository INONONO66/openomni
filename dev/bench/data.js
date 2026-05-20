window.BENCHMARK_DATA = {
  "lastUpdate": 1779260686614,
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
      }
    ]
  }
}