window.BENCHMARK_DATA = {
  "lastUpdate": 1781763970543,
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
          "id": "118c81adf3649be98bb24edcb39aa88711c14ce3",
          "message": "feat(openomni): publish built-in app connectors",
          "timestamp": "2026-06-13T03:02:50+09:00",
          "tree_id": "a1366c4b7cb232a478c9fc216a65ce117a87c211",
          "url": "https://github.com/INONONO66/openomni/commit/118c81adf3649be98bb24edcb39aa88711c14ce3"
        },
        "date": 1781287401789,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 686.4960458027964,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 784.6663214140638,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1294.1730684611684,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.09499385167873,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 601.9834936611419,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 443.0395544805056,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2774.928406915537,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2606.8239879042026,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9577.117506224768,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6020.710174594387,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2415,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 22591,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2430,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7831,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14897,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 710,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1583,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10847,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102199,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 518457,
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
          "id": "c32fc4e6c8e4e5dc8c5b749673825dc00d65d774",
          "message": "feat(openomni): discover built-in app connectors (#259)",
          "timestamp": "2026-06-13T03:27:47+09:00",
          "tree_id": "fa83b9df3c02aa34788a9081a5e1c26526cc11e5",
          "url": "https://github.com/INONONO66/openomni/commit/c32fc4e6c8e4e5dc8c5b749673825dc00d65d774"
        },
        "date": 1781288893710,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 705.288300678419,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 812.5010034368298,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1407.0339233452098,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.84159798091732,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 650.5623755806431,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.66767391884207,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2958.422726465706,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2664.18843745873,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9617.270673076859,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6297.722148749622,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2344,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19262,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2462,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8216,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15822,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 829,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1591,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11169,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104814,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 556080,
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
          "id": "35b6aea7d77637a4fa74513d0cd1e917762db2a3",
          "message": "feat(openomni): register app connector installations\n\nRefs #216\n\nVerification:\n- GitHub Actions CI passed: dependency rules, lint, check-types, tests, benchmarks\n- local full gate passed: bun run check-types && bun run lint && bun run build && git diff --check && bun test\n- manual SQLite reopen QA passed\n- ultrawork reviewer PASS\n- claude-fable-5 oracle PASS",
          "timestamp": "2026-06-13T04:06:15+09:00",
          "tree_id": "b041bad3925c9c4dfc40bf9c9cfc12aceeefa59b",
          "url": "https://github.com/INONONO66/openomni/commit/35b6aea7d77637a4fa74513d0cd1e917762db2a3"
        },
        "date": 1781291211792,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 691.9229337484732,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 935.8922508188406,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1414.7824795214808,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.094819758768104,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 627.4671489794642,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 467.8527016088788,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3086.016540657555,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2522.3027719623515,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10996.399934022342,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5886.595184835796,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2715,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21133,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2389,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7915,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15195,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 707,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1577,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10994,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103230,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 518025,
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
          "id": "ea3cdfbee3745a89ecdf3f9383af81950939ed50",
          "message": "feat(openomni): record app connector consent (#261)\n\n* fix(agent): fail fast on missing tool executor\n\n* feat(openomni): record app connector consent\n\n* fix(openomni): address app connector consent review",
          "timestamp": "2026-06-13T11:11:22+09:00",
          "tree_id": "35552e25e5d96c80b6efdb6c8a78bd471ab694b0",
          "url": "https://github.com/INONONO66/openomni/commit/ea3cdfbee3745a89ecdf3f9383af81950939ed50"
        },
        "date": 1781316708280,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 801.5719450121447,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 813.0452863938442,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1403.9425647221535,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.831132790938724,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 614.6248455756349,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 461.04087579126303,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3036.0775396195227,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2841.761324239623,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9666.106321284,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5886.672062632627,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2272,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21235,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2399,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8047,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15228,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 694,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1595,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 12072,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103083,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 514855,
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
          "id": "f0b78e4cb286094b577f245b009a03cfb19ea692",
          "message": "feat(openomni): disable app connector installations (#262)",
          "timestamp": "2026-06-13T14:20:51+09:00",
          "tree_id": "932ff65e43f0822affe9bb807765c51dbd8cc7f0",
          "url": "https://github.com/INONONO66/openomni/commit/f0b78e4cb286094b577f245b009a03cfb19ea692"
        },
        "date": 1781328081260,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 723.9943673392669,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 829.1058518223111,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1422.1142381747536,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.00526223754225,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 612.5669839752475,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.5512600754153,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2932.342785092322,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2487.130798119388,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9200.116375344003,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5870.31693572044,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2320,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21366,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2435,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8138,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15216,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 717,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1694,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11002,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104239,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 520012,
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
          "id": "f6ecfd9725a2afc062cb4e5f3c4305c90eddb7b6",
          "message": "feat(openomni): smoke verify app connectors (#263)",
          "timestamp": "2026-06-13T14:45:49+09:00",
          "tree_id": "38b85f471d7e02f4140c0aa0b57968a8d37bc394",
          "url": "https://github.com/INONONO66/openomni/commit/f6ecfd9725a2afc062cb4e5f3c4305c90eddb7b6"
        },
        "date": 1781329574908,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 733.373714780203,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 856.1720477058681,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1464.2383887781868,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.08869152834543,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 677.7662460012202,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446.4873175544153,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3276.948782645848,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2597.7646447591396,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9811.497203963718,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6194.857337545767,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2260,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19216,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2470,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8307,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15999,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 824,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1551,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10731,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103212,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 555004,
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
          "id": "df2cffb6a3e115c9b634bc9709df43b940de3b17",
          "message": "feat(openomni): wire local cli app connectors (#264)",
          "timestamp": "2026-06-13T15:21:31+09:00",
          "tree_id": "7d0e796af10d3c2a0d543107b2b234ab0a92acd8",
          "url": "https://github.com/INONONO66/openomni/commit/df2cffb6a3e115c9b634bc9709df43b940de3b17"
        },
        "date": 1781331714821,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 730.9678959102908,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 872.811473907324,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1513.1856217655873,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.88550033398999,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 669.80354726789,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 451.29025037453425,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3184.998311994438,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2638.246886872043,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9927.008636092925,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6198.952392759836,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2517,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20648,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2536,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8770,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16479,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 750,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1522,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11197,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102684,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 549096,
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
          "id": "7ae94ef9e740000981ea329c609d94f746312b0c",
          "message": "feat(openomni): execute local cli agent runtime\n\nAdds the default local_cli_agent runtime owner for enabled AppConnector spawn templates, with stdout/stderr/exit/timeout mapping and dispatch completion-gate coverage.",
          "timestamp": "2026-06-13T16:04:24+09:00",
          "tree_id": "bb48af7cd7c507561be2e3b1a303d5030947cbb7",
          "url": "https://github.com/INONONO66/openomni/commit/7ae94ef9e740000981ea329c609d94f746312b0c"
        },
        "date": 1781334293738,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 693.4237719467841,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 793.8444470904694,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1319.2706728233786,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.08300543950845,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 605.571287560459,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 440.6410464301101,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2851.274541670553,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2509.7625298032576,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10141.524591825499,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5891.167952871031,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2595,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20564,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2382,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8085,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14960,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 723,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1772,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11243,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102636,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 538993,
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
          "id": "3d4453006b9e547c2493e5f5d21eeaf64bf090da",
          "message": "feat(openomni): wire local cli runtime into server boot",
          "timestamp": "2026-06-13T16:29:31+09:00",
          "tree_id": "1a760b0fddf889e9fc946423291340374c96cdc7",
          "url": "https://github.com/INONONO66/openomni/commit/3d4453006b9e547c2493e5f5d21eeaf64bf090da"
        },
        "date": 1781335798477,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 417.3076717633138,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 483.1923636311081,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 796.3566001976737,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 32.737538622067476,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 424.9819213361282,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 235.91940765414918,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 1710.8416451384032,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 1247.4774581472614,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 4950.0339075341,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 2942.0978523095737,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1373,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 11113,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 1442,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 5227,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 9963,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 402,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 871,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 6440,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 59889,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 296804,
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
          "id": "80ddb17a26f2e850e42b7526ca095e1c8b2f02ec",
          "message": "feat(openomni): materialize local cli credentials\n\nMaterialize connector-declared local CLI credentials only with owner consent, wire server bootstrap credentials into the default local CLI runtime, and redact materialized secret values from result surfaces.",
          "timestamp": "2026-06-13T17:02:37+09:00",
          "tree_id": "76d5b674df85696d62e573af217d1d40b6de8796",
          "url": "https://github.com/INONONO66/openomni/commit/80ddb17a26f2e850e42b7526ca095e1c8b2f02ec"
        },
        "date": 1781337780376,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 725.6337447664175,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 835.9678320040653,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1431.740729604965,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.74045394094047,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 679.2580796348702,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 489.17543267482165,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3133.6457758833744,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2966.293091685617,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 12160.317242217037,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6285.6412947834115,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2247,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19267,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2410,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8181,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15678,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 810,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1503,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10664,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 100966,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 512604,
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
          "id": "295430a79d3f03ab59e3247bd084aca83843ca1c",
          "message": "feat(openomni): emit app connector drift incidents\n\nSquashed PR #268: AppConnector smoke verification now emits sanitized verification-failed incidents and resident profile reload tests use an explicit reload surface.",
          "timestamp": "2026-06-13T17:30:24+09:00",
          "tree_id": "438fe9c22595cd6afd7809cbdc61d4442c0bd702",
          "url": "https://github.com/INONONO66/openomni/commit/295430a79d3f03ab59e3247bd084aca83843ca1c"
        },
        "date": 1781339453564,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 702.80813426376,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 820.702733531799,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1387.354703107645,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.4014034602095,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 634.8302914495254,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450.87555852125286,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2959.809418102309,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2512.8098097846682,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10035.160260912488,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5948.511745465359,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2847,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21122,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2456,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8060,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15305,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 729,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1589,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11099,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102069,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 531099,
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
          "id": "2a1206998d8e467d74bd8084b0d74ba0a7599131",
          "message": "feat(openomni): materialize local cli question hooks\n\nMaterialize AppConnector questionBridge metadata into local CLI child process env, reserve OPENOMNI_QUESTION_BRIDGE_* against connector/credential overrides, and update the implementation-status SSOT.",
          "timestamp": "2026-06-13T17:50:15+09:00",
          "tree_id": "68a9147052e548cede6e145adc880afbe7d8e5ea",
          "url": "https://github.com/INONONO66/openomni/commit/2a1206998d8e467d74bd8084b0d74ba0a7599131"
        },
        "date": 1781340642219,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 583.2356495467816,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 679.52162568028,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1216.9046558606703,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 38.6090318864397,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 562.6183266662689,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 380.6998348880654,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2561.5414585415865,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2040.0280911485875,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8139.794318735977,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 4880.849968275996,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1787,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 15927,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 1830,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 6675,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 12397,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 584,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1198,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8523,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 78817,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 405126,
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
          "id": "2d140dac06b537dbe2d333097923c283b980726e",
          "message": "feat(openomni): ingest local cli logs\n\nCapture configured AppConnector logs for local CLI runs as redacted artifacts, expose artifact references on execution results, and record them as WorkItem evidence.",
          "timestamp": "2026-06-13T18:12:11+09:00",
          "tree_id": "0efd651ade9f65897192129f66d0064ee6c4ae01",
          "url": "https://github.com/INONONO66/openomni/commit/2d140dac06b537dbe2d333097923c283b980726e"
        },
        "date": 1781341954363,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 711.1545047898023,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 857.7179751091011,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1546.9628730105355,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.435734308718246,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 704.4686936429687,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448.59253195057346,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3168.20349131939,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2615.1019351465125,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9902.707594811945,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6162.242975104682,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2226,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19338,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2382,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8956,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16166,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 866,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1543,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10692,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102577,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 522937,
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
          "id": "1a30adbfbac55322320b10845a5e4b54afdbd427",
          "message": "feat(openomni): route local cli question bridge",
          "timestamp": "2026-06-13T19:06:58+09:00",
          "tree_id": "ba4863d5947e2b037d4197dca6a19f0534abcef4",
          "url": "https://github.com/INONONO66/openomni/commit/1a30adbfbac55322320b10845a5e4b54afdbd427"
        },
        "date": 1781345243858,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 650.579989615168,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 774.2951451800745,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1123.116871447859,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 42.84754972027377,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 478.62640798015167,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 382.9783464566659,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2273.2655603544586,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2170.0473069746695,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 7317.8178691642515,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5016.684910203428,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1783,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 17172,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2268,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8173,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15564,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 644,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1425,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10122,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 96034,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 474838,
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
          "id": "164a7b56388b2fe4dd69b71c59001db47d7c70bb",
          "message": "docs(openomni): update app question bridge status (#272)",
          "timestamp": "2026-06-13T19:20:39+09:00",
          "tree_id": "e362d0f44b9fb19ce8f922f05932c3382b9d2813",
          "url": "https://github.com/INONONO66/openomni/commit/164a7b56388b2fe4dd69b71c59001db47d7c70bb"
        },
        "date": 1781346068622,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 678.1536348840574,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 850.3066791377595,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1263.952829354063,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.90898954305865,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 604.3774386559103,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445.0391944816169,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2808.9318277574307,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2496.359669487996,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9693.14783700283,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5832.871799358587,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2363,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20523,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2402,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7933,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15634,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 851,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1763,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10815,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101793,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 513502,
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
          "id": "a59b9fef97ec462f03e6a631feebf1525ff5b0bf",
          "message": "feat(openomni): project local CLI log events\n\nAdds structured local CLI log events to Execution.Result, projects redacted jsonl/stream_json logs, records log event evidence on WorkItems, and updates the implementation SSOT.",
          "timestamp": "2026-06-13T20:07:19+09:00",
          "tree_id": "f7cceb3ae078b7e090091f662bf093a0e19925ef",
          "url": "https://github.com/INONONO66/openomni/commit/a59b9fef97ec462f03e6a631feebf1525ff5b0bf"
        },
        "date": 1781348869493,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 718.5686805685731,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 814.673308947571,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1329.2675794232005,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.01532698910666,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 638.0441079824972,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450.1376021246306,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2922.4395055236205,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2491.6209293633865,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9665.739126232615,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5828.628431544088,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2571,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21089,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2487,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7955,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15280,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 728,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1574,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10797,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102740,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 514776,
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
          "id": "e826764ac6fb64d2f9df963fb721ff208c1188aa",
          "message": "feat(openomni): extract local CLI log telemetry\n\nAdds declarative structured-log telemetry extraction for local CLI token usage and tool calls, records those observations as WorkItem evidence, and updates the SSOT.",
          "timestamp": "2026-06-13T20:27:28+09:00",
          "tree_id": "552a3ee34d70b3a9edbfab3eff1939d46360fc22",
          "url": "https://github.com/INONONO66/openomni/commit/e826764ac6fb64d2f9df963fb721ff208c1188aa"
        },
        "date": 1781350077390,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 760.014257811107,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 895.8728577446045,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1529.8621760548633,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.857453112817545,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 659.2505603606021,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 444.6185107301123,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3480.1314772925753,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2845.3721155213793,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9860.550187339915,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6615.156975590651,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2268,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19625,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2448,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8625,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16382,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 849,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1629,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10846,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102887,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 526703,
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
          "id": "7724df72c276e9bce5394b4e79219ccb942b92ef",
          "message": "feat(openomni): detect stalled local CLI runs (#275)",
          "timestamp": "2026-06-13T20:39:44+09:00",
          "tree_id": "5a3638adc18070f07d863eef7bf1377a7c2d4f87",
          "url": "https://github.com/INONONO66/openomni/commit/7724df72c276e9bce5394b4e79219ccb942b92ef"
        },
        "date": 1781350811091,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 688.0858522956938,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 805.8993915460628,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1296.4339404939576,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.97262013247457,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 582.6907200875804,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445.79735464834897,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2636.3113729831557,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2527.826541961358,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8725.258703428886,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5948.290090411809,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 3527,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 26718,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2308,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7805,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14782,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 697,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1575,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11018,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102131,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 540734,
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
          "id": "79ee3293d74bc65b94d796ae3a0179b6504cf06f",
          "message": "feat(openomni): use local CLI log activity for liveness (#276)",
          "timestamp": "2026-06-13T20:52:11+09:00",
          "tree_id": "f8d82a45c167363b5fdd355268fefdb850954b72",
          "url": "https://github.com/INONONO66/openomni/commit/79ee3293d74bc65b94d796ae3a0179b6504cf06f"
        },
        "date": 1781351561250,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 701.6713234211363,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 827.8464518692481,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1420.595249595288,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.70828606904488,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 653.7572403603257,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 442.67697068173993,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2927.7565581448885,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2596.807187930264,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9672.85617564555,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6236.676707201972,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2736,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20696,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2430,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8318,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16659,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 795,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1639,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10988,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104087,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 525906,
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
          "id": "0ed5984245e3b169922d1825de7613b1334b2472",
          "message": "feat(openomni): register outbound dispatch actions (#277)",
          "timestamp": "2026-06-13T21:04:26+09:00",
          "tree_id": "de0a921902c15e618906fe82e3f5ed9377e53e86",
          "url": "https://github.com/INONONO66/openomni/commit/0ed5984245e3b169922d1825de7613b1334b2472"
        },
        "date": 1781352291782,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 722.5627723144271,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 827.1712740087224,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1381.9428014702742,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.70211288641247,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 651.382621156877,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 442.5315944825442,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2848.6497080185763,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2595.6040958286794,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9273.101632047406,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6164.225543980975,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2362,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19217,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2404,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8308,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15775,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 769,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1590,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10871,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103122,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 524025,
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
          "id": "178c8f913a99dbe46e3f75fb8ec2ff56d2357a4f",
          "message": "feat(openomni): register device command dispatch (#278)",
          "timestamp": "2026-06-13T21:12:41+09:00",
          "tree_id": "e6b46cb0d7e32b398d30d3b39c1074ccfbcbd840",
          "url": "https://github.com/INONONO66/openomni/commit/178c8f913a99dbe46e3f75fb8ec2ff56d2357a4f"
        },
        "date": 1781352785401,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 745.8246718375796,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 877.6929679816664,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1571.8113859984248,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.00165105444286,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 763.1216413184059,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450.0049140492118,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3274.20031432144,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2639.9545418546377,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11190.217522658984,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6499.068304413028,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2458,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20663,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2530,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8730,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 17043,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 753,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1528,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10776,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103998,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 525783,
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
          "id": "404aac964da0334120c625e8cca1193ec6a983d4",
          "message": "feat(openomni): build connector read-back requests (#279)",
          "timestamp": "2026-06-13T21:25:57+09:00",
          "tree_id": "e4c5937e29286424ef0976f810ddd0b00980888e",
          "url": "https://github.com/INONONO66/openomni/commit/404aac964da0334120c625e8cca1193ec6a983d4"
        },
        "date": 1781353600934,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 761.8546918687349,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 928.783640450355,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1465.1966564594593,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.76334104993232,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 667.5580707610025,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 449.3518780640184,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3049.9092655848776,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2599.9706211162907,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9785.438649707072,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6268.506299755158,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2594,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19057,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2344,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8118,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16052,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 751,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1503,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10761,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101856,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 537091,
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
          "id": "97b53ff663239389d786e3d6de00d23fc441fda5",
          "message": "refactor(session): share timestamped store mechanics\n\nExtract internal timestamp/sub-adapter helpers for session registry stores.",
          "timestamp": "2026-06-14T01:10:27+09:00",
          "tree_id": "2279a883d6666c9598d54b9f7585ac9007a1a1b7",
          "url": "https://github.com/INONONO66/openomni/commit/97b53ff663239389d786e3d6de00d23fc441fda5"
        },
        "date": 1781367057532,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 740.2665023282284,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 855.4871634743419,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1524.3904878047529,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.87795215125301,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 721.8169048649886,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448.347118479704,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3142.207227023184,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2630.569722477865,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11313.915148772538,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6273.973212044683,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2344,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21388,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2575,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8432,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16239,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 737,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1507,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11084,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 105018,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 538903,
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
          "id": "933b760991d52b09b69d1961afb476f428182026",
          "message": "refactor(session): share create timestamp defaults\n\nShare create-time timestamp defaulting across session lifecycle stores.",
          "timestamp": "2026-06-14T01:20:14+09:00",
          "tree_id": "2d9e1aea48ca9917f0740074eeeebc9129a5db46",
          "url": "https://github.com/INONONO66/openomni/commit/933b760991d52b09b69d1961afb476f428182026"
        },
        "date": 1781367646799,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 724.9827454960403,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 823.91530995615,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1434.7279626971997,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 52.253604975307134,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 659.8638385197576,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 467.0480218204033,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2913.977125706665,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2611.14217452655,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9355.719524744281,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6225.800908920837,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2318,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19609,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2467,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8260,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15808,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 728,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1508,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10668,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101675,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 521746,
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
          "id": "77103df6679d329e10a9b0779dcc250ba0f61a4a",
          "message": "refactor(session): remove artifact reset no-op\n\nRemove dead Artifact._reset no-op and its test-only call sites.",
          "timestamp": "2026-06-14T01:26:45+09:00",
          "tree_id": "60f63c4de39bac11a8153545bc320de10a7a1d73",
          "url": "https://github.com/INONONO66/openomni/commit/77103df6679d329e10a9b0779dcc250ba0f61a4a"
        },
        "date": 1781368031790,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 721.4678984466865,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 875.8295643643395,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1390.7172280475404,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 48.012074553119824,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 638.9415624660608,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 441.7448923247357,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3023.085643459823,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2495.7739592688604,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9490.906614785907,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5907.043889183724,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2242,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20528,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2588,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7952,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14991,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 719,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1576,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11241,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 109658,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 541610,
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
          "id": "a66bbb3670cbdbc6c8327c2643165fcc1c9a98df",
          "message": "refactor(session): share pending sqlite query helpers\n\nExtract internal helpers for pending SQLite data query mechanics while preserving existing read/write semantics.",
          "timestamp": "2026-06-14T01:43:04+09:00",
          "tree_id": "196df8b76a249fb3cfd3783e58ba3e5cd2e052ad",
          "url": "https://github.com/INONONO66/openomni/commit/a66bbb3670cbdbc6c8327c2643165fcc1c9a98df"
        },
        "date": 1781369007846,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 750.0661031189367,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 868.0161883928585,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1526.884705235804,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.01117899842795,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 732.2252471260306,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 466.1835316164715,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3075.472905646257,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2599.6242331286085,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9823.995088408747,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6153.575164605534,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2302,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20233,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2486,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8824,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16107,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 830,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1532,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10902,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104794,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 529789,
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
          "id": "755e4d106c4f2fa09d3d408a33bbf0b0e72974d0",
          "message": "refactor(session): reuse sub-adapter guard helper\n\nReuse the shared sub-adapter guard for pending ask, pending interaction, and worker grant stores.",
          "timestamp": "2026-06-14T01:49:34+09:00",
          "tree_id": "648992f72923e3f4c9cca67720f91a27d002a122",
          "url": "https://github.com/INONONO66/openomni/commit/755e4d106c4f2fa09d3d408a33bbf0b0e72974d0"
        },
        "date": 1781369400526,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 736.9941482971758,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 877.0360723022926,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1445.2199323642526,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.55614758618321,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 675.6699504060215,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450.2683596738929,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3051.0313634563513,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2598.8181133054736,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9806.120023534573,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6174.252948076282,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2233,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20217,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2432,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8443,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16024,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 724,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1527,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10724,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101544,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 513561,
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
          "id": "696ebe40c365c30c42a397c85f1d5d39ae9fa739",
          "message": "refactor(session): reuse worker run state guard\n\nReuse the shared sub-adapter guard in WorkerRunStateStore and avoid a duplicate adapter lookup during create.",
          "timestamp": "2026-06-14T01:54:59+09:00",
          "tree_id": "0bfb2a171f132a9a3f4247f7ace6337a85840b61",
          "url": "https://github.com/INONONO66/openomni/commit/696ebe40c365c30c42a397c85f1d5d39ae9fa739"
        },
        "date": 1781369724784,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 745.7383665433022,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 789.4730355971574,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1256.088277040111,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.15906291067913,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 589.0352889203351,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 540.1738707689444,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2658.9516870957045,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2593.3556183711294,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8726.592321116901,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6030.112035696978,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2365,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20157,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2294,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7879,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14780,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 702,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1585,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10920,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101518,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 512480,
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
          "id": "936960b1319d59b6877afc90a181de44fb7af159",
          "message": "refactor(session): reuse app connector guard",
          "timestamp": "2026-06-14T02:06:49+09:00",
          "tree_id": "7925c1b109e98cd2e72426b22ec3c83c8fa66f76",
          "url": "https://github.com/INONONO66/openomni/commit/936960b1319d59b6877afc90a181de44fb7af159"
        },
        "date": 1781370439232,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 733.6713890580257,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 875.9016983594748,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1384.9940168686855,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.97577130694758,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 681.9375277037109,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 452.9626578006742,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3048.671940735009,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2510.6635535135865,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10002.344068813814,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5871.9031178434925,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2295,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20935,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2496,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8186,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15513,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 719,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1581,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11214,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 118283,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 514766,
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
          "id": "71f7ad7ce55a67f81451e57c2968d816b7b48ea2",
          "message": "refactor(openomni): remove unused session lock wrapper (#287)",
          "timestamp": "2026-06-14T02:21:56+09:00",
          "tree_id": "56ca181cf1600430635d40116ee0a5dde6642ff5",
          "url": "https://github.com/INONONO66/openomni/commit/71f7ad7ce55a67f81451e57c2968d816b7b48ea2"
        },
        "date": 1781371347439,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 709.9505874836,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 837.0596069173752,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1433.9953993664863,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.44135158493865,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 611.5648778398785,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446.26032532297984,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2977.794651896661,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2504.14984724803,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9462.869984859937,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5913.364969546084,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2583,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21220,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2490,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8446,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16222,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 720,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1588,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10903,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101845,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 516721,
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
          "id": "75a79025fc34d427ac85f8555bfab56aec5aa936",
          "message": "refactor(agent): remove duplicate retry aliases (#288)",
          "timestamp": "2026-06-14T02:31:16+09:00",
          "tree_id": "217f368b8dd00069998e28d1dcce2322de0400ec",
          "url": "https://github.com/INONONO66/openomni/commit/75a79025fc34d427ac85f8555bfab56aec5aa936"
        },
        "date": 1781371899685,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 747.0857725581048,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 858.4123438774818,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1508.399541450404,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.17005991814389,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 692.4761304619311,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 467.4266049042478,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3395.6044142615638,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2629.988717355289,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10261.813442791145,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6177.141824695912,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2253,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19665,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2466,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8602,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16386,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 744,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1767,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10932,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104105,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 544972,
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
          "id": "6d3a337dc40b1f1891eecd846243817697d4f713",
          "message": "refactor(server): remove disabled local runner stub (#289)",
          "timestamp": "2026-06-14T02:38:42+09:00",
          "tree_id": "5ebba404b60c23abff8d520c40f94e6a8c74ee56",
          "url": "https://github.com/INONONO66/openomni/commit/6d3a337dc40b1f1891eecd846243817697d4f713"
        },
        "date": 1781372352195,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 750.6974551460783,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 797.7191244276808,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1355.3454907700982,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.017430770359965,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 660.8136114029833,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 458.4703347285478,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2751.600830971671,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2513.0339255647036,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9534.768306635942,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6461.949857844341,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2307,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20408,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2393,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7978,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16144,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 735,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1669,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10915,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102549,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 529740,
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
          "id": "d856fe9fbe9242bc593fe63208f7f63c22930fea",
          "message": "refactor(agent): remove unused internal barrels",
          "timestamp": "2026-06-14T02:49:36+09:00",
          "tree_id": "419706d93f4471dbe2cd813631b552774a62c905",
          "url": "https://github.com/INONONO66/openomni/commit/d856fe9fbe9242bc593fe63208f7f63c22930fea"
        },
        "date": 1781373003427,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 747.9620260738426,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 836.129440881719,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1385.1149909275055,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 51.39530801977134,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 652.0157461318682,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 529.953878195522,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2888.719741175157,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2611.2658502198074,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10200.25550795624,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6146.897596657021,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2094,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19728,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2526,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8499,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16338,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 765,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1596,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11225,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 106877,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 540789,
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
          "id": "985e82fbba729de0d99cd2037dbd7e6eab90ff78",
          "message": "refactor(coordinator): drop unused runtime dependencies",
          "timestamp": "2026-06-14T03:03:49+09:00",
          "tree_id": "f0afa6b2ef68f0058be576f922e34feb23066b0c",
          "url": "https://github.com/INONONO66/openomni/commit/985e82fbba729de0d99cd2037dbd7e6eab90ff78"
        },
        "date": 1781373854888,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 705.6469720704458,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 829.3456629374342,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1317.6011911035696,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.99197753031668,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 619.3802802071299,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450.48251458433896,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2780.7287136419645,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2506.9659304569414,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9387.408992771489,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5875.236355090843,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2277,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20154,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2335,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7843,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14916,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 761,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1603,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11120,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102698,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 544935,
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
          "id": "187af01fa9289baa9f89097ae3d1354009c3e1e3",
          "message": "refactor(openomni): drop unused llm dependency",
          "timestamp": "2026-06-14T03:13:05+09:00",
          "tree_id": "8dccaa3610e409dbf83c1ae0bdcbd9b2ba755fff",
          "url": "https://github.com/INONONO66/openomni/commit/187af01fa9289baa9f89097ae3d1354009c3e1e3"
        },
        "date": 1781374409987,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 706.3853750195195,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 815.8539703519198,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1421.426085967751,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.75014191232785,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 672.2016993130154,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450.08401258435947,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2991.832580403851,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2588.962874747014,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9882.124011857153,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6355.74107029283,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2349,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19700,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2498,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8416,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16384,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 784,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1528,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11007,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101231,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 536561,
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
          "id": "92f99affd89d84bcc47556783867e93e819a2091",
          "message": "refactor(llm): use protocol message types in tests\n\nReplace stale LLM session test Message imports with the protocol SSOT and update the package map to match the current session module shape.",
          "timestamp": "2026-06-14T03:27:39+09:00",
          "tree_id": "1f96e1cc4026ed0ee7ba557e9bbe8fe94be7fd51",
          "url": "https://github.com/INONONO66/openomni/commit/92f99affd89d84bcc47556783867e93e819a2091"
        },
        "date": 1781375285585,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 747.226400854768,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 848.2427920705079,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1446.6354391191603,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.179521826217425,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 660.7872732679816,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446.3108854771454,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3424.6820205479485,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2592.396396630077,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 12002.881060969417,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6745.4677908942385,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2579,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21098,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2467,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8077,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 17019,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 740,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1607,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10950,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102611,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 642050,
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
          "id": "5cea7ea510629846323595aa8ef4331d7cc78bd7",
          "message": "refactor(llm): keep convert helpers internal\n\nKeep convert.ts builder helpers file-local, remove dead buildSystemBlock, and preserve SDKMessage/toModelMessages as the exported contract.",
          "timestamp": "2026-06-14T03:36:57+09:00",
          "tree_id": "ac562a4c27965728a5538509d203f23c34c845db",
          "url": "https://github.com/INONONO66/openomni/commit/5cea7ea510629846323595aa8ef4331d7cc78bd7"
        },
        "date": 1781375843298,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 783.263109662893,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 882.6371074514097,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1504.3376006015192,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 54.55364284510444,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 774.6234555947,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 588.8291045698937,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3203.0446494345356,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2775.6657044524286,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10893.411546840576,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6342.7674108845895,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2121,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19727,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2496,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8378,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16066,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 769,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1655,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 12266,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 109947,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 601802,
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
          "id": "65eb45e39bdee34061640067d6caf1d7fc9e17f8",
          "message": "refactor(agent): remove unused execution helpers\n\nRemove unused agent execution shared helpers that are not referenced by ChatAgent execution or exported from the package root.",
          "timestamp": "2026-06-14T03:46:30+09:00",
          "tree_id": "44a40a2e51240ed955a03d8e82c97118ad267f35",
          "url": "https://github.com/INONONO66/openomni/commit/65eb45e39bdee34061640067d6caf1d7fc9e17f8"
        },
        "date": 1781376420564,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 715.7380972831355,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 833.6344023275321,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1461.631714339634,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.06907428801957,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 651.1964588054617,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 451.29256360965564,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3016.9621975500536,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2598.9573511449125,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9901.911881187758,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6245.259601574222,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2255,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20204,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2516,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8308,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15898,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 746,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1582,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10984,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 105938,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 534924,
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
          "id": "0751a9d9d83098285d24f04c3d7046f8e22f5af3",
          "message": "refactor(agent): keep tracking sink internal",
          "timestamp": "2026-06-14T03:59:07+09:00",
          "tree_id": "b2b1bc6cfe9fb2011214d60b6e50b73e02e9b300",
          "url": "https://github.com/INONONO66/openomni/commit/0751a9d9d83098285d24f04c3d7046f8e22f5af3"
        },
        "date": 1781377175993,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 774.6070659499379,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 987.7821349898774,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1553.59408401689,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 54.40866066034283,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 659.8456889100272,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 594.6261587770315,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2983.2842397306404,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2765.6871231818523,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10503.159962189591,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6306.403291921441,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2157,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19668,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2537,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8355,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16197,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 773,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1652,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11393,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 116982,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 545761,
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
          "id": "a3a1f0ccc0b850394b0de985a6729ec0dc1e47fa",
          "message": "refactor(agent): keep mcp converters internal",
          "timestamp": "2026-06-14T04:09:49+09:00",
          "tree_id": "b8abcb345c01e0fa1244a75d63e9f5c8883da428",
          "url": "https://github.com/INONONO66/openomni/commit/a3a1f0ccc0b850394b0de985a6729ec0dc1e47fa"
        },
        "date": 1781377814406,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 724.0930240979533,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 909.0262980874812,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1356.1283139637314,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 54.059817180527496,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 723.7955009337237,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 525.5417857894064,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3600.5660689850547,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2679.056313124483,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10320.819607843798,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6255.791567622461,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2365,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19487,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2523,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8673,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16443,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 762,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1604,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11390,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 108386,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 543709,
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
          "id": "6ded5a91f9c7107d31e8541ead494314485b3b08",
          "message": "refactor(agent): trim mock llm helper surface",
          "timestamp": "2026-06-14T04:21:27+09:00",
          "tree_id": "c2dc012224a033d58831c682a4a690767d64dacf",
          "url": "https://github.com/INONONO66/openomni/commit/6ded5a91f9c7107d31e8541ead494314485b3b08"
        },
        "date": 1781378511385,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 757.8321940647176,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 902.2178765403053,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1617.603688126877,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.9585499034909,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 751.3922922599517,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 449.7523398322315,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3512.8039201907154,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2635.8435646700113,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11000.508744912313,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6202.9545341768535,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2247,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19639,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2489,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8477,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16322,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 751,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1496,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11117,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102785,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 542588,
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
          "id": "7309dc013210d8ee8a6123a8bcb6112374d279db",
          "message": "refactor(coordinator): keep ipc encoder internal",
          "timestamp": "2026-06-14T04:32:38+09:00",
          "tree_id": "eba0044cb24e1467e921537a3bc9839ea261d32d",
          "url": "https://github.com/INONONO66/openomni/commit/7309dc013210d8ee8a6123a8bcb6112374d279db"
        },
        "date": 1781379184170,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 760.8881195501707,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 895.0984514858609,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1349.3388970599674,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.04303918593626,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 630.7180132450907,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 444.32252890315635,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2873.032953141927,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2529.3739376772537,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9262.454663331959,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5848.867235934741,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2286,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20319,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2951,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7894,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14956,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 735,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1580,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11242,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102677,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 542311,
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
          "id": "cfc93e1c8592728d72b2521a2e498d4c16d48621",
          "message": "refactor(agent): trim builtin policy surface",
          "timestamp": "2026-06-14T04:43:04+09:00",
          "tree_id": "ecfc56641d656cc17c726f038b3e196d5fe55c53",
          "url": "https://github.com/INONONO66/openomni/commit/cfc93e1c8592728d72b2521a2e498d4c16d48621"
        },
        "date": 1781379814693,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 719.3274588365821,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 869.9272317623456,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1519.265807784714,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.667128570780925,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 694.6647494008942,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 443.6915858409738,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3074.37666595161,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2609.78759329863,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10049.556125011277,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6204.587231666117,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2284,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19538,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2435,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8297,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15999,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 823,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1544,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10791,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104389,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 520374,
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
          "id": "e558c75886ffa12ff4582b72ad09c272a8c9e5ae",
          "message": "refactor(openomni): trim dispatch barrel surface\n\nTrim unused dispatch domain barrel exports while preserving root public API and internal handler wiring.",
          "timestamp": "2026-06-14T04:53:06+09:00",
          "tree_id": "070271e9306eedd9e298ce72b2f7694c2cd3ad2a",
          "url": "https://github.com/INONONO66/openomni/commit/e558c75886ffa12ff4582b72ad09c272a8c9e5ae"
        },
        "date": 1781380417410,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 708.6589871875294,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 807.5178985277115,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1498.1849193984413,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 48.68207599760307,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 594.4684873200916,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446.0358923807951,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2915.388589253968,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2514.3703359149736,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9236.5930544007,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5927.10129208166,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2258,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20342,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2448,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8281,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15877,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 680,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1572,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11225,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 108389,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 555091,
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
          "id": "92f8db9cd9d8b1b50d44c98eb933935283841abb",
          "message": "refactor(openomni): trim agent tool barrel surface\n\nTrim unused agent tool barrel exports while preserving provider behavior and parent public API.",
          "timestamp": "2026-06-14T05:02:23+09:00",
          "tree_id": "45af24472481b71f4c5e86facdf18061057989df",
          "url": "https://github.com/INONONO66/openomni/commit/92f8db9cd9d8b1b50d44c98eb933935283841abb"
        },
        "date": 1781380968360,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 707.9166784652409,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 821.9991369034894,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1398.04482098178,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.66012924536812,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 673.3962330219631,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 473.2561680783625,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3008.027883892363,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2603.9161285281207,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9919.852098006417,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6167.310638297537,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2359,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19413,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2470,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8258,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15728,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 759,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1532,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10789,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 106342,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 524986,
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
          "id": "7a44bb40ea195ec5f27cad850541f9f1cbb73019",
          "message": "refactor(openomni): remove dispatch namespace alias\n\nRemove unused dispatch namespace-style alias while preserving canonical DispatchRuntime and DispatchRegistry exports.",
          "timestamp": "2026-06-14T05:10:27+09:00",
          "tree_id": "d74226fabc77e4c806617e24814ea5bb1a0ffac5",
          "url": "https://github.com/INONONO66/openomni/commit/7a44bb40ea195ec5f27cad850541f9f1cbb73019"
        },
        "date": 1781381453837,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 792.4232556666509,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 855.8618302252685,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1629.6564379185913,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.497790666992124,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 667.8974713473026,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 474.20170617550417,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3046.3770791448396,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2605.423557917891,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9720.365377138594,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6205.0956192606345,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2338,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19762,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2499,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8588,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16435,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 765,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1512,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11398,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102744,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 534031,
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
          "id": "7994b35bd30d89d8c10fabaf5210c6bb4a20075f",
          "message": "refactor(openomni): keep bash classifiers internal",
          "timestamp": "2026-06-14T05:19:09+09:00",
          "tree_id": "ff08acdf49e6ceb1499e1701238de3de1f9613c1",
          "url": "https://github.com/INONONO66/openomni/commit/7994b35bd30d89d8c10fabaf5210c6bb4a20075f"
        },
        "date": 1781381975762,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 692.7503948572327,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 782.8721806864952,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1272.5744772910596,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.099653911766154,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 627.7988536414242,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 439.07197678191756,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2674.004492218822,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2487.2727272723873,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8827.303292435292,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5824.717106413065,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2282,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20335,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2363,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7771,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14918,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 737,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1576,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10642,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101344,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 512876,
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
          "id": "df7875f986ca79adf2cce69c64608276b25263c8",
          "message": "refactor(openomni): trim system tool barrel surface",
          "timestamp": "2026-06-14T05:27:11+09:00",
          "tree_id": "7cc753e85fdd310ccb338980d7b8cc47fb52f6d6",
          "url": "https://github.com/INONONO66/openomni/commit/df7875f986ca79adf2cce69c64608276b25263c8"
        },
        "date": 1781382461456,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 699.4329908444562,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 819.4241582471185,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1333.4285219014828,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.982342632694696,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 674.1156239256388,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.06256622097777,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2859.5157416146517,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2499.294861541652,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10004.165966386478,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5841.115647451092,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2748,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 24811,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2459,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8069,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15269,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 693,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1582,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10790,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102112,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 515971,
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
          "id": "2fb5a025358da520aff06990c3530455f3c61343",
          "message": "refactor(openomni): trim ingress barrel aliases",
          "timestamp": "2026-06-14T05:34:47+09:00",
          "tree_id": "5b509370026310467bf3a1dcc4a628fb91270e5f",
          "url": "https://github.com/INONONO66/openomni/commit/2fb5a025358da520aff06990c3530455f3c61343"
        },
        "date": 1781382912201,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 754.6090598329297,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 870.182293615638,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1619.9550144986154,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.5059097675582,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 735.5393973271632,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 453.5701216469952,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3334.2316617758675,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2612.768119349962,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11429.417485714472,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6210.745870078926,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2228,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19771,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2475,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8496,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16318,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 747,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1534,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10764,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102889,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 524655,
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
          "id": "4023bff447a4d0da6925d01c569bb98e4a54dde0",
          "message": "refactor(openomni): keep skill shared internals private",
          "timestamp": "2026-06-14T05:44:39+09:00",
          "tree_id": "7a1d9cdc5a7bef0286518ba110937d621ae5dd1a",
          "url": "https://github.com/INONONO66/openomni/commit/4023bff447a4d0da6925d01c569bb98e4a54dde0"
        },
        "date": 1781383506814,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 615.9837996328505,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 721.3259254451043,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1379.46264415378,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 38.70658089297222,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 581.5748457373949,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 367.997729463943,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2660.271261738212,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2201.2872457515273,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9254.363150128922,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5012.677042606584,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1798,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 15180,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2635,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 6659,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 12267,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 597,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1190,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8345,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 86401,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 435169,
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
          "id": "d47490d0f85fa74c9796106483e2474f42e47b79",
          "message": "refactor(openomni): keep background store internal",
          "timestamp": "2026-06-14T05:52:11+09:00",
          "tree_id": "507c6abb9de1f7914887e8a7148de8a1c11fa9f4",
          "url": "https://github.com/INONONO66/openomni/commit/d47490d0f85fa74c9796106483e2474f42e47b79"
        },
        "date": 1781383960942,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 703.9657803777228,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 854.7552246716893,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1327.538086767401,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.55327178353318,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 661.2514266443326,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 443.99344222991084,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2851.0106910704058,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2521.470600100701,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8985.655674364836,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5869.144433358881,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2276,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20510,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2373,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7894,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14957,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 691,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1566,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10774,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101840,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 515650,
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
          "id": "8930cecf4844970ead020ecaea86c3a1230d9118",
          "message": "refactor(openomni): trim policy barrel middleware surface",
          "timestamp": "2026-06-14T06:00:39+09:00",
          "tree_id": "77b939e45b85a78e676e60338cf8f48410064c87",
          "url": "https://github.com/INONONO66/openomni/commit/8930cecf4844970ead020ecaea86c3a1230d9118"
        },
        "date": 1781384463065,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 709.6984209218532,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 829.6809730438391,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1510.8057410487263,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.805566069940284,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 735.0456904282361,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.6320826506916,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3233.0393779699793,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2607.9095579601626,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10610.20445623361,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6279.745117739185,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2477,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 22708,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2579,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8389,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16279,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 740,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1514,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10858,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103603,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 526123,
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
          "id": "c5eb07dfa53ac0c2ab2a98eb7aa722ab0fdb1860",
          "message": "refactor(openomni): keep subagent helpers internal (#310)",
          "timestamp": "2026-06-14T06:11:40+09:00",
          "tree_id": "055291aab6a2a00f1c66a8067f5730ec02ef0bcf",
          "url": "https://github.com/INONONO66/openomni/commit/c5eb07dfa53ac0c2ab2a98eb7aa722ab0fdb1860"
        },
        "date": 1781385128351,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 695.7081237520371,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 786.6305526058319,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1275.952802623436,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.158725375465735,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 599.0680121730898,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 466.9851125432891,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2743.9361760508914,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2497.552022976885,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9027.179725582311,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5937.018701021351,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2337,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20736,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2356,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7859,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14906,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 762,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1682,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11149,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 126208,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 630436,
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
          "id": "43f4792af3be75b4e6cf7e1b27ef66100e737f38",
          "message": "refactor(openomni): trim tool barrel type surface (#311)",
          "timestamp": "2026-06-14T06:19:33+09:00",
          "tree_id": "87efc26775bf7611256e0390faaf1b61559c1172",
          "url": "https://github.com/INONONO66/openomni/commit/43f4792af3be75b4e6cf7e1b27ef66100e737f38"
        },
        "date": 1781385600368,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 751.1524686582464,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 876.6305731368365,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1484.9694841259568,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.49248629925355,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 697.7693874987424,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 454.3560420188233,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3233.958411487482,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2614.562199330529,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9951.66086177743,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6323.04071825921,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2510,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19618,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2649,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8464,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16313,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 732,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1519,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10775,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101519,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 518432,
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
          "id": "68ccd7939da1527dcee2c6d3e4b71eaae95d3b7e",
          "message": "refactor(openomni): keep local cli helper types internal (#312)",
          "timestamp": "2026-06-14T06:28:03+09:00",
          "tree_id": "731f0fc4cee9912eb3e8ea3049699f1388ed87f8",
          "url": "https://github.com/INONONO66/openomni/commit/68ccd7939da1527dcee2c6d3e4b71eaae95d3b7e"
        },
        "date": 1781386109703,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 705.5996302671314,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 815.7682079225051,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1462.4023486055405,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.59146323014203,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 671.159071384483,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.7107571218367,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3023.1826894001438,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2592.554625116602,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9986.383463151318,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6177.550963677186,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2433,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 29816,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2501,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8237,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15827,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 784,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1624,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10755,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101532,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 514789,
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
          "id": "bfaa9b06da3116191d3b2ea80a0a04c006288e48",
          "message": "refactor(openomni): keep ingress model config internal\n\nKeep ModelConfig file-local in the ingress session resolver while preserving IngressSessionResolver.resolve behavior.",
          "timestamp": "2026-06-14T06:37:09+09:00",
          "tree_id": "188ecf9c624fbe19baa1ec934da2dbf7906deefd",
          "url": "https://github.com/INONONO66/openomni/commit/bfaa9b06da3116191d3b2ea80a0a04c006288e48"
        },
        "date": 1781386660409,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 702.4555767852262,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 804.4432225887135,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1396.7514910260136,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.947975087500794,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 609.2810289467423,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 464.7460729090875,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2680.1032615976023,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2483.749465997891,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8840.31046676114,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5876.50684609554,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2416,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 22919,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2284,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7844,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14990,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 721,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1586,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10905,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102092,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 520463,
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
          "id": "f1524b00de3f54674d4690939324a4ba26031638",
          "message": "refactor(agent): keep compaction result internal\n\nKeep the compaction result helper type file-local while preserving InMemoryCompactor behavior and declaration emit.",
          "timestamp": "2026-06-14T06:44:20+09:00",
          "tree_id": "946984d5aa10f658b786264fde2951821c07871c",
          "url": "https://github.com/INONONO66/openomni/commit/f1524b00de3f54674d4690939324a4ba26031638"
        },
        "date": 1781387083632,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 721.2159949804415,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 912.5969628938517,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1480.322383905842,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.649350636447245,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 664.749941834557,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 457.3009488966266,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3021.9569382331883,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2606.023558231179,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10099.631387598933,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6167.8685086962605,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2537,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19687,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2526,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8393,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 17940,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 828,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1554,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11079,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104424,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 550808,
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
          "id": "755654c14081e236a6e9ce500f8bf6ebcb8742fe",
          "message": "refactor(agent): remove legacy policy type exports\n\nRemove unused legacy policy type declarations while preserving the actual registry public API.",
          "timestamp": "2026-06-14T06:52:07+09:00",
          "tree_id": "79643c13d63ffd7f53736a4e452e8af28056d626",
          "url": "https://github.com/INONONO66/openomni/commit/755654c14081e236a6e9ce500f8bf6ebcb8742fe"
        },
        "date": 1781387551104,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 706.505521688641,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 821.8770146209833,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1418.5892499966506,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.43769345583633,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 644.9585614870534,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 452.4462064691197,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3183.050418563338,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2607.01999582892,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9871.338268680547,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6245.251233371686,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2464,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19907,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2530,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8651,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 18187,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 823,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1633,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10867,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101534,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 522148,
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
          "id": "8264ddd1dcc6993ed6e0c46ca550487e11357f47",
          "message": "refactor(agent): keep policy runtime context internal\n\nKeep the policy runtime context helper internal while preserving registry public API and declaration emit.",
          "timestamp": "2026-06-14T06:59:40+09:00",
          "tree_id": "6c0ea925f576942bcd6c28c4c1ebaaed71bc0ae7",
          "url": "https://github.com/INONONO66/openomni/commit/8264ddd1dcc6993ed6e0c46ca550487e11357f47"
        },
        "date": 1781388010058,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 701.3203753445313,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 806.0454688343607,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1339.6159894973034,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.10574152897042,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 636.8822978696292,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 443.3565060096852,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2986.4398685979613,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2514.322706359107,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10830.42104693909,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5919.732019179274,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2705,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20678,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2465,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8097,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15485,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 687,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1585,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10781,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102269,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 513508,
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
          "id": "4af19fa09ae24c616806e38e54e3d4d67b0caf83",
          "message": "refactor(agent): keep runtime tool specs internal\n\nRemove unused deep runtime tool spec type exports and keep the spec return interfaces local to their defining modules.",
          "timestamp": "2026-06-14T07:10:55+09:00",
          "tree_id": "30545bc7ebb32bd2ba0757c80ec23d579e6ba27f",
          "url": "https://github.com/INONONO66/openomni/commit/4af19fa09ae24c616806e38e54e3d4d67b0caf83"
        },
        "date": 1781388686137,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 714.6448581433037,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 851.663075507716,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1388.7929171585736,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.24958597556656,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 616.6011715377604,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 466.788629043553,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2890.092280570002,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2521.892492371501,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10096.293286218754,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6006.873798654645,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2377,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21050,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2414,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7925,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15359,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 731,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1580,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10889,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103064,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 521996,
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
          "id": "c210b1eb37a827340470e1d7bd10813c2e224741",
          "message": "refactor(openomni): keep llm mock helper internal\n\nKeep the ingress test mock assistant message helper local to its module.",
          "timestamp": "2026-06-14T07:17:44+09:00",
          "tree_id": "cd8ebe237756aeac371fa199ecd742e87da3df8c",
          "url": "https://github.com/INONONO66/openomni/commit/c210b1eb37a827340470e1d7bd10813c2e224741"
        },
        "date": 1781389093172,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 674.3661658393629,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 776.9088458310916,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1237.5079076330555,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.78995616246743,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 617.8992455464922,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 452.8689808210375,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3108.1198794058955,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2504.871277208851,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8810.933480176536,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5960.248122540829,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2216,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19881,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2587,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7783,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15177,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 711,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1586,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10927,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101148,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 533672,
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
          "id": "4158f9c43576cfd70cfc592d550c8c03570a781f",
          "message": "refactor(coordinator): remove dead harness spawn helper\n\nDelete the unused coordinator test harness spawn helper and remove its inert cleanup hook.",
          "timestamp": "2026-06-14T07:23:41+09:00",
          "tree_id": "a92c4c5fd4207e8209ca87df2ca630a3e753b2c9",
          "url": "https://github.com/INONONO66/openomni/commit/4158f9c43576cfd70cfc592d550c8c03570a781f"
        },
        "date": 1781389451879,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 712.0952852291044,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 823.9301722005255,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1450.9292678678812,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.48745419329497,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 702.5733275253726,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 468.7033957488716,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3086.9327365330482,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2600.5556509078483,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9887.621514732109,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6154.855182175166,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2299,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 22131,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2411,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8250,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15826,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 769,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1504,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10770,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102627,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 509906,
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
          "id": "a69681a1dcc88bc0c3262cb8ccbfc02661d1687f",
          "message": "refactor(server): keep trigger prefix helper internal\n\nKeep the server trigger prefix helper local while preserving public trigger evaluation and normalization APIs.",
          "timestamp": "2026-06-14T07:30:26+09:00",
          "tree_id": "25f7ad8a8ecf9a0be2b51c6a0c4ffb7133641886",
          "url": "https://github.com/INONONO66/openomni/commit/a69681a1dcc88bc0c3262cb8ccbfc02661d1687f"
        },
        "date": 1781389850347,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 724.8970793977958,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 825.2803888720983,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1431.2541327338658,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.47645564626293,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 660.6474066341865,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 474.58895918071966,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3015.3366300806474,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2621.7495552999785,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9382.32404540771,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6187.582168048276,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2260,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19295,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2421,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8323,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16038,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 751,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1502,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10722,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101663,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 518300,
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
          "id": "8b4544c3494b9f7d17d4dda810ef2786bb44a0a0",
          "message": "refactor(server): keep mcp prefix guard internal\n\nKeep the MCP prefix guard out of the server MCP barrel while preserving focused implementation tests.",
          "timestamp": "2026-06-14T07:37:36+09:00",
          "tree_id": "e43177163653ec606363c07dba73f83aef6ff092",
          "url": "https://github.com/INONONO66/openomni/commit/8b4544c3494b9f7d17d4dda810ef2786bb44a0a0"
        },
        "date": 1781390286335,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 719.8708850735558,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 869.8409154168636,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1351.9941729200264,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.00352714446566,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 632.8095123587077,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 443.22206709475114,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2847.181305696738,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2476.1326697371956,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8916.81817374323,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5826.453449078889,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2465,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21332,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2436,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7999,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15423,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 709,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1574,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10690,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102124,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 515150,
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
          "id": "463a5076a9da089ef2f16c9f1c44c808698d5348",
          "message": "refactor(server): keep worker tool selection internal\n\nKeep worker tool selection local to worker-runtime while preserving createExecutionToolContext behavior.",
          "timestamp": "2026-06-14T07:44:35+09:00",
          "tree_id": "b7f8d8337bccbbc39707bee26614b8c7ccec17b2",
          "url": "https://github.com/INONONO66/openomni/commit/463a5076a9da089ef2f16c9f1c44c808698d5348"
        },
        "date": 1781390702439,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 706.4017645853586,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 820.5441163196558,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1320.745598626055,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.990810948446295,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 622.6372160788973,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 454.50861293160546,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2959.6905114242572,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2533.5605127813255,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9960.409760956483,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5956.722480343103,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2274,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20548,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2376,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7955,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15380,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 744,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1606,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11188,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102106,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 540037,
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
          "id": "e486c5686a88b1e247be8977a56f22c5f599ffb1",
          "message": "refactor(server): keep mcp parse options schema internal\n\nKeep the MCP parse options schema file-local while preserving parser behavior and exported config APIs.",
          "timestamp": "2026-06-14T07:53:55+09:00",
          "tree_id": "ef682189cf96c8bef68071c421653cbd3b550fd6",
          "url": "https://github.com/INONONO66/openomni/commit/e486c5686a88b1e247be8977a56f22c5f599ffb1"
        },
        "date": 1781391264746,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 691.3366863005832,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 847.4268524542965,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1253.213634939533,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.94875590491625,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 618.137207390466,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.6935460764001,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2768.301433949965,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2488.814385266025,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8977.656611904134,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5867.400844872192,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2475,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20342,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2345,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7847,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14879,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 703,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1579,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10748,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101614,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 512955,
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
          "id": "ebcc34ccdb1dd2da2ffbb5910a86ea112841555b",
          "message": "refactor(server): remove unused config getter\n\nRemove the unused server config getter while preserving load/reset config behavior.",
          "timestamp": "2026-06-14T08:00:34+09:00",
          "tree_id": "d2aa3a470424e821554d7abf13ad83800d5b7283",
          "url": "https://github.com/INONONO66/openomni/commit/ebcc34ccdb1dd2da2ffbb5910a86ea112841555b"
        },
        "date": 1781391664716,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 704.0871025432025,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 788.5706005739119,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1294.6856251374784,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.8663699714089,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 634.1246686704368,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.28424720344344,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2878.779169185374,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2494.2947720242214,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9363.313857677129,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5868.268059386015,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2515,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20628,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2495,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7837,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15261,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 682,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1578,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10812,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101838,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 516768,
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
          "id": "6de5514b02ddd9d5b9d26629d58727d358a98116",
          "message": "refactor(server): trim config public surface\n\nRemove test-only and redundant server config exports while preserving loadConfig behavior.",
          "timestamp": "2026-06-14T08:09:26+09:00",
          "tree_id": "263e8c540aa1c36ac65f435b4a0a97e20a15f781",
          "url": "https://github.com/INONONO66/openomni/commit/6de5514b02ddd9d5b9d26629d58727d358a98116"
        },
        "date": 1781392196727,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 751.5664757695979,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 876.670424659022,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1520.1909640936522,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.47048542403132,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 684.2212217417687,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450.9874941371936,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3073.2613786531983,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2600.296479276257,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11098.940066592557,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6278.575094103489,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2271,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19557,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2538,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8468,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 18458,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 774,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1524,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10826,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 114874,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 551548,
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
          "id": "201fa41b2e8cce4f3c55c2be0bb6928fecab37a6",
          "message": "refactor(server): keep model catalog resolver internal\n\nKeep catalog model matching behind the public runtime resolver surface.",
          "timestamp": "2026-06-14T08:17:14+09:00",
          "tree_id": "88e5fb2b68799903c1ba6bbd7e2eed723e8ef1b2",
          "url": "https://github.com/INONONO66/openomni/commit/201fa41b2e8cce4f3c55c2be0bb6928fecab37a6"
        },
        "date": 1781392664199,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 749.6270417762911,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 813.8295761582792,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1319.0182683935923,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.10951969985548,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 596.7179444338722,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448.5717579508587,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2821.969777351384,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2507.7842060387893,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9662.312753623066,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5838.3469554561325,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2556,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20762,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2419,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7877,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15050,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 691,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1580,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11111,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102267,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 541490,
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
          "id": "ad26c708b1e1370d66454b7edb1e40edc9329789",
          "message": "refactor(server): trim agent registry barrel\n\nKeep the server agents barrel limited to bootstrap-facing registry APIs and move registry-internal test setup imports to the registry leaf module.",
          "timestamp": "2026-06-14T08:27:24+09:00",
          "tree_id": "618625218ee5dc5a672841d7508c46f88279282b",
          "url": "https://github.com/INONONO66/openomni/commit/ad26c708b1e1370d66454b7edb1e40edc9329789"
        },
        "date": 1781393267321,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 707.0485951043379,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 842.8363717581508,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1434.852885470371,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.797882893209604,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 643.3030338119443,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448.35779713695445,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3019.1797596763768,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2612.01525401567,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10676.563040460593,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6262.342977018149,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2500,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19229,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2425,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 10670,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 17136,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 887,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1598,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10932,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101523,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 536739,
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
          "id": "d12c1bf9b6cbf59a0302f7d07723f83b2ee1cc8c",
          "message": "refactor(server): trim context barrel\n\nLimit the server context barrel to production-facing entrypoints and keep leaf context modules imported directly by their tests and internals.",
          "timestamp": "2026-06-14T08:36:38+09:00",
          "tree_id": "605d1e8219d7bd090201a13932c4c87055cad42a",
          "url": "https://github.com/INONONO66/openomni/commit/d12c1bf9b6cbf59a0302f7d07723f83b2ee1cc8c"
        },
        "date": 1781393821725,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 716.1360723007682,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 814.2269004038404,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1356.8403956525824,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.53333419200114,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 631.3811899004214,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445.4572473484504,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2859.17097438211,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2606.581050437088,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9434.39867924556,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6361.48047073864,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2446,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19177,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2706,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8243,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16012,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 788,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1539,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10762,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 99632,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 504139,
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
          "id": "55c574e86326e1c7df10a99bb39c4bd261fef662",
          "message": "refactor(server): remove find-up cache reset export\n\nRemove the test-only find-up cache reset export and keep cache coverage focused on production behavior and loader-owned cache resets.",
          "timestamp": "2026-06-14T08:46:17+09:00",
          "tree_id": "599982942b3249f73b656c563e8ee9726a0c4023",
          "url": "https://github.com/INONONO66/openomni/commit/55c574e86326e1c7df10a99bb39c4bd261fef662"
        },
        "date": 1781394406087,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 684.679002286962,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 925.6374937518385,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1284.2918127526825,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.98253659592027,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 589.2902896944667,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 451.53086436472125,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2817.9614506714206,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2486.3985678409613,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9151.314330161184,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5876.749191984835,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2599,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20494,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2478,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8079,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15353,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 699,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1586,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10727,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101595,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 509235,
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
          "id": "213f4d139a5050318ddd3ab249e0173a21083e6b",
          "message": "refactor(coordinator): trim ipc public surface\n\nNarrow coordinator IPC exports to the live createIpcServer API and keep IPC server helper types local.",
          "timestamp": "2026-06-14T08:56:32+09:00",
          "tree_id": "7e618bbe2c6244582e1cde655a75e11223dd51e7",
          "url": "https://github.com/INONONO66/openomni/commit/213f4d139a5050318ddd3ab249e0173a21083e6b"
        },
        "date": 1781395018261,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 694.5530011529441,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 796.8055967236924,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1335.9166121167514,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.95896585092782,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 593.2947772484337,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 449.6842462642398,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2744.5433362610343,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2499.836112291502,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8759.675543097474,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5889.5858068315265,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2330,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20393,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2414,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7912,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16422,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 704,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1600,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10855,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 107194,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 511578,
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
          "id": "b19f858b463f7fd270150b30a0efef3c2a9c2ebc",
          "message": "refactor(coordinator): keep ipc frame limit internal\n\nMake the IPC frame limit constant local to framing while preserving decoder behavior and tests.",
          "timestamp": "2026-06-14T09:03:58+09:00",
          "tree_id": "5bd842934974e7adbe0d371f16ef8cc1d0404d93",
          "url": "https://github.com/INONONO66/openomni/commit/b19f858b463f7fd270150b30a0efef3c2a9c2ebc"
        },
        "date": 1781395467550,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 728.5484700567962,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 847.6705800576073,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1454.551360000067,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.48657726086057,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 647.3372238297438,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450.4238831785966,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2929.6971348217694,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2710.9215463023943,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9454.223794696603,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6182.154549950539,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2334,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19097,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2471,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8344,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16049,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 771,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1515,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10899,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102257,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 520513,
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
          "id": "b652a442f1328ddaccadfeb3f3acafda167a8cfc",
          "message": "refactor(coordinator): remove session routing singleton\n\nRemove the unused worker-pool SessionRouting singleton and keep tests on isolated createSessionRouting instances.",
          "timestamp": "2026-06-14T09:11:13+09:00",
          "tree_id": "15dd7686926c8c9f0d80b280a62f141c418160c0",
          "url": "https://github.com/INONONO66/openomni/commit/b652a442f1328ddaccadfeb3f3acafda167a8cfc"
        },
        "date": 1781395899203,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 760.1938485396649,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 864.9997924000253,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1416.428379201198,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 67.57647392734422,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 696.787055101882,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 570.8381454715775,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3143.6515985038122,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2694.508339395828,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10036.227920514015,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6272.162506271365,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2100,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19644,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2553,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8434,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16277,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 744,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1632,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11261,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 106540,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 576100,
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
          "id": "7f9ce05a8b15836d05891060634fc3ab91a94f5d",
          "message": "refactor(llm): remove codex model allowlist export\n\nRemove the unused provider submodule CODEX_ALLOWED_MODELS export and its assertion-only test.",
          "timestamp": "2026-06-14T09:19:25+09:00",
          "tree_id": "2f2068f6d0484ba9b4971050d0462669d5d2424d",
          "url": "https://github.com/INONONO66/openomni/commit/7f9ce05a8b15836d05891060634fc3ab91a94f5d"
        },
        "date": 1781396391694,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 764.5743547006367,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 795.3979112977077,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1361.5054391482804,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.93832634895261,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 617.4939948747578,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446.8504573504461,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2954.1441907178514,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2520.148988181355,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9081.28332727908,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5840.476404625352,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2330,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20420,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2262,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7858,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14866,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 710,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1575,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11170,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102552,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 537816,
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
          "id": "34522ccee5c8685c2ee1cb78aea5a20319b8ca5f",
          "message": "refactor(llm): keep provider cache internals private\n\nRemove test-only provider cache exports and cover cache behavior through public getSDK/getLanguage identity.",
          "timestamp": "2026-06-14T09:28:20+09:00",
          "tree_id": "0d0213eba5c5fe26d8eb28f74b640fa36ea99e09",
          "url": "https://github.com/INONONO66/openomni/commit/34522ccee5c8685c2ee1cb78aea5a20319b8ca5f"
        },
        "date": 1781396936378,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 749.2673380087352,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 847.2689677959921,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1449.467315051108,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.9104447069466,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 672.4381795807228,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 470.29317983011305,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2914.7516686581903,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2614.1567679198333,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11113.608135141549,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6225.522007097408,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2961,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 23915,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2402,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8434,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15821,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 812,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1525,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10734,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104831,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 524705,
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
          "id": "c43b603c76d75ea724244c30e9349324330e4430",
          "message": "refactor(coordinator): remove worker-pool barrel\n\nRemove the unused internal worker-pool barrel while keeping worker-manager leaf internals intact. Update boundary coverage and status docs to reflect the root public API.",
          "timestamp": "2026-06-14T09:45:16+09:00",
          "tree_id": "31cbe297eb49878ae07d52303b7cfb874e0397ec",
          "url": "https://github.com/INONONO66/openomni/commit/c43b603c76d75ea724244c30e9349324330e4430"
        },
        "date": 1781397942684,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 712.6371740695392,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 827.1448162914751,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1428.4030995572393,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.22776530195043,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 669.03771350574,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 474.5510900410743,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3016.8267768795267,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2606.5083928477284,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10349.44541032904,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6298.872889897389,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2437,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20011,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2524,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8405,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16258,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 708,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1512,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10825,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101711,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 515764,
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
          "id": "88de4401da762ecf54fa90a98a488ed1a3f03d48",
          "message": "refactor(coordinator): trim internal type barrels\n\nRemove unused type re-exports from coordinator internal credentials and tool-permission barrels while preserving runtime exports and leaf module contracts.",
          "timestamp": "2026-06-14T09:52:18+09:00",
          "tree_id": "d6d613f257529cc3fae1c59d00efbb3c32f7785d",
          "url": "https://github.com/INONONO66/openomni/commit/88de4401da762ecf54fa90a98a488ed1a3f03d48"
        },
        "date": 1781398365697,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 697.4158954438608,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 948.9399986714702,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1744.9088291743717,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.619052226703396,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 668.2784568194121,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 504.9520246012627,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3284.5287722526846,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2694.0172683189853,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9740.17298139708,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6408.691425275913,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2297,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20654,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2549,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8466,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16184,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 817,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1649,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11081,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 110833,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 525314,
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
          "id": "02269b558ee6456314c25ce3c8c013857f8bd199",
          "message": "refactor(server): keep channel payload subtypes internal\n\nMake unimported GitHub and Telegram payload helper interfaces file-local while preserving exported payload/message contracts.",
          "timestamp": "2026-06-14T09:59:17+09:00",
          "tree_id": "c729f1251c2694f6f40ca839d0d29ad22ebf4302",
          "url": "https://github.com/INONONO66/openomni/commit/02269b558ee6456314c25ce3c8c013857f8bd199"
        },
        "date": 1781398782787,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 741.0015263555204,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 808.3265946182012,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1396.1161836153854,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.50624471522988,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 669.6522781452786,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 443.98732418133324,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2896.8673561020955,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2605.3122134220607,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10085.935854765261,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6201.125379799125,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2475,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19401,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2672,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8577,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16062,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 759,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1601,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11035,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104397,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 554935,
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
          "id": "5dad155159e1857c4fcc67018e140f4ed9215c11",
          "message": "refactor(server): trim channel authn type surface (#338)",
          "timestamp": "2026-06-14T10:10:13+09:00",
          "tree_id": "65da1553740ecfe468516402c80e5501b85dc683",
          "url": "https://github.com/INONONO66/openomni/commit/5dad155159e1857c4fcc67018e140f4ed9215c11"
        },
        "date": 1781399443466,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 720.9832660417561,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 818.9315950243007,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1405.7656320288127,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.509782262738135,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 626.7230699813589,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 452.4467222572538,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2821.2199684026104,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2500.341842730281,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9258.320218478557,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5846.822789990011,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2559,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20516,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2413,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7899,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15091,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 674,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1569,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11160,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 109249,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 556508,
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
          "id": "fb0b1f49270366023910d048dc71c213f4ade80a",
          "message": "refactor(server): trim internal type surface (#339)",
          "timestamp": "2026-06-14T10:19:59+09:00",
          "tree_id": "e1cf643d11a4ef6532453f177c5463df249a3795",
          "url": "https://github.com/INONONO66/openomni/commit/fb0b1f49270366023910d048dc71c213f4ade80a"
        },
        "date": 1781400031337,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 715.7153827987245,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 817.9980777097528,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1363.371680209763,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.18987078941806,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 655.3396154703523,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 494.5144027020252,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3025.4133841595863,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2543.5969731654263,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10034.118302227655,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5882.355647059047,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2389,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 29016,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2374,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8043,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15490,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 726,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1595,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10961,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102712,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 515294,
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
          "id": "b49b1fed2687e1ff0ce3369e706344bfe4e83940",
          "message": "refactor(session): keep store signature types internal (#340)",
          "timestamp": "2026-06-14T10:26:20+09:00",
          "tree_id": "a1aa5c4ba52bbbd522e518e819ba22745dcbdd29",
          "url": "https://github.com/INONONO66/openomni/commit/b49b1fed2687e1ff0ce3369e706344bfe4e83940"
        },
        "date": 1781400406247,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 679.4452265609254,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 783.3264896875539,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1265.8673763892757,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.99019267851766,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 585.967320606088,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 442.41135404404866,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2857.6144020579145,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2510.516958300495,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8598.503783320117,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5835.687266573374,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2267,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21297,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2283,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7769,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14924,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 725,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1578,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10702,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102973,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 513488,
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
          "id": "a95b727172e978dab52f20778fb04458d40f94cb",
          "message": "refactor(server): trim namespace member surface (#341)",
          "timestamp": "2026-06-14T10:37:25+09:00",
          "tree_id": "07e875c6d5f4d2e767479e1288231dc755a20d85",
          "url": "https://github.com/INONONO66/openomni/commit/a95b727172e978dab52f20778fb04458d40f94cb"
        },
        "date": 1781401075925,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 884.1736162688065,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 860.639444716859,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1512.4842022476648,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.804989065254055,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 698.5444099053683,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 449.68158557424715,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3054.6135377846995,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2627.1164061471263,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9850.630516153531,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6253.221610806725,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2332,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19349,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2569,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8407,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16193,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 792,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1718,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11542,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 106858,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 552300,
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
          "id": "c7c981513e6f8303952fec51750836bdd3393b00",
          "message": "refactor(server): trim worker ipc type surface (#342)",
          "timestamp": "2026-06-14T10:47:07+09:00",
          "tree_id": "0a3f15eeb50fd067681fa7f43d5e295cb8149e70",
          "url": "https://github.com/INONONO66/openomni/commit/c7c981513e6f8303952fec51750836bdd3393b00"
        },
        "date": 1781401653773,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 820.8279555769774,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 922.2334627480118,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 2114.92591417619,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.110648311214625,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 826.0948868938624,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 452.9023138691297,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3574.7840137270014,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2666.1405566815806,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11425.315320461683,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6210.159473389877,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2309,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 22555,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2576,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8831,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16800,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 844,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1552,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11103,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103131,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 520404,
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
          "id": "6892e59e22579635b5d727627603eaa03381128f",
          "message": "refactor(server): trim worker bootstrap type surface (#343)",
          "timestamp": "2026-06-14T10:57:10+09:00",
          "tree_id": "3d2da4f4a2c4ab848af2a5aa31cb5aae5bad5516",
          "url": "https://github.com/INONONO66/openomni/commit/6892e59e22579635b5d727627603eaa03381128f"
        },
        "date": 1781402258022,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 748.527433456003,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 847.9514041990674,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1722.0924245294896,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 51.86865302829907,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 633.8245073617563,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 582.9200004662362,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2911.5257810002545,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2840.5197273110207,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8828.632294517056,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6350.632945957527,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2371,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19599,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2507,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8918,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16216,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 833,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1683,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11233,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 107081,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 558123,
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
          "id": "79eeef485b3566676ef7fe746d8d1ad2197075cc",
          "message": "refactor(server): trim worker heartbeat type surface (#344)",
          "timestamp": "2026-06-14T11:07:53+09:00",
          "tree_id": "a1ce819f14f4055007cf7512c1aa711972375cb0",
          "url": "https://github.com/INONONO66/openomni/commit/79eeef485b3566676ef7fe746d8d1ad2197075cc"
        },
        "date": 1781402897789,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 778.3934381568523,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 895.8331870139974,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1567.4355867642619,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.84654840082746,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 765.55055311009,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 451.1148082318866,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3191.43178554344,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2629.7350829674283,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10248.217462594725,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6282.169357371672,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2483,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19478,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2579,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8563,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16378,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 812,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1514,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10937,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102096,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 516465,
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
          "id": "c3852d2a47fc2003c465faaafdc5ba13bcc76511",
          "message": "refactor(server): trim worker run state type surface (#345)",
          "timestamp": "2026-06-14T11:20:01+09:00",
          "tree_id": "3bd85fb981c4b72c86aab6abb0bc879c8ec052b6",
          "url": "https://github.com/INONONO66/openomni/commit/c3852d2a47fc2003c465faaafdc5ba13bcc76511"
        },
        "date": 1781403625547,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 761.4559043006622,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 903.8580854505594,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1532.1758009409662,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.83220504947362,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 1028.9561102081316,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 472.4273950858997,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3243.0203333761315,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2628.2174564376496,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10329.07198925868,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6228.831080660016,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2505,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19680,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2513,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8371,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16089,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 778,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1539,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11087,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103096,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 543292,
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
          "id": "7bf70792b8fa5b3cd41e770a602ea32b2a3f7dbb",
          "message": "refactor(server): trim worker runner type surface (#346)",
          "timestamp": "2026-06-14T11:31:36+09:00",
          "tree_id": "db62ac4fc976067338b011d8e97990e6ef2c1fba",
          "url": "https://github.com/INONONO66/openomni/commit/7bf70792b8fa5b3cd41e770a602ea32b2a3f7dbb"
        },
        "date": 1781404320104,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 721.9378343451932,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 841.9452148215536,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1436.6096734354553,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.64279774887001,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 664.9065213632679,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 461.7276316154267,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2941.056790776993,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2735.4106898624864,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9429.821310702222,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6515.683606984218,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2341,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19965,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2508,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8217,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15889,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 753,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1517,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11078,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103090,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 558514,
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
          "id": "75f66c057d59f032df117f6495fec31b99fef7a8",
          "message": "refactor(server): trim mcp prefix guard surface",
          "timestamp": "2026-06-14T11:41:46+09:00",
          "tree_id": "13f204b0425b0d22f4cce7b00a519953c847dcda",
          "url": "https://github.com/INONONO66/openomni/commit/75f66c057d59f032df117f6495fec31b99fef7a8"
        },
        "date": 1781404932418,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 704.2997570165194,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 810.0458809235538,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1450.0588866492603,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.4441994743206,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 652.520653574326,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445.61509565130245,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3009.432844804431,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2506.466150337312,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9617.153956973274,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5864.222013722363,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2298,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21666,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2558,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8079,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15536,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 747,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1606,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10924,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103503,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 517513,
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
          "id": "a9376b5fd4de47027c4450c2e1b262ce902a3593",
          "message": "refactor(server): remove context cache reset exports",
          "timestamp": "2026-06-14T11:49:30+09:00",
          "tree_id": "f21ad0b6eb0f451e8448f2c9a3fd46fab463e24d",
          "url": "https://github.com/INONONO66/openomni/commit/a9376b5fd4de47027c4450c2e1b262ce902a3593"
        },
        "date": 1781405395589,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 696.8434340267652,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 835.5686795512062,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1275.6014286624193,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.98965382271558,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 642.7072407321863,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446.82415338483935,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2755.2066894421646,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2519.3928148541345,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9550.589190221408,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5819.269362817041,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2300,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20443,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2352,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8023,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15129,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 706,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1574,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11119,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101718,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 540202,
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
          "id": "dbce2b2da3edd1e46a381015bde6332ac9c1cef3",
          "message": "refactor(server): remove worker heartbeat send export",
          "timestamp": "2026-06-14T11:59:10+09:00",
          "tree_id": "90e1f6ace17fe9e8e08ef09e519117113d1e3965",
          "url": "https://github.com/INONONO66/openomni/commit/dbce2b2da3edd1e46a381015bde6332ac9c1cef3"
        },
        "date": 1781405982675,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 727.1524981276281,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 856.1942446658097,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1408.021373357913,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.14912177714537,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 647.3838788616262,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448.8270983783282,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2993.798551028422,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2519.2456984507485,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9753.918560421229,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6439.896387404743,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 3449,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21374,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2493,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8302,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15364,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 753,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1598,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10974,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103417,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 517823,
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
          "id": "f0a763f8c3444480e73ccf93a9f73f83d6617987",
          "message": "refactor(llm): remove models dev init export",
          "timestamp": "2026-06-14T12:10:48+09:00",
          "tree_id": "b8bbd8bfdeee78a12e4bf4de1966853d9b368dbb",
          "url": "https://github.com/INONONO66/openomni/commit/f0a763f8c3444480e73ccf93a9f73f83d6617987"
        },
        "date": 1781406672070,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 829.2649212061366,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 837.2548665006971,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1493.792632648249,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.77261680005434,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 697.7019005357671,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.9709716435685,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3049.642889817788,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2610.725563909382,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10045.994985457795,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6187.127327847324,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2558,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19893,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2428,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8402,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16171,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 764,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1503,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10882,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103011,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 531004,
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
          "id": "56c009dc1bedf394b6ed5d60092d49c6169ebace",
          "message": "refactor(llm): remove provider dead surface",
          "timestamp": "2026-06-14T12:23:54+09:00",
          "tree_id": "97dae897ad3dd615571c6bc075cf36c160e56556",
          "url": "https://github.com/INONONO66/openomni/commit/56c009dc1bedf394b6ed5d60092d49c6169ebace"
        },
        "date": 1781407463424,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 720.2722977304952,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 877.4259103272346,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1366.7995188888244,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.46373581305836,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 704.9661052795049,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 444.7298849041614,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2798.3024401162993,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2498.6325520959917,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9281.181624129615,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5865.849483810529,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2398,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21050,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2417,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7917,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15106,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 731,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1566,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10872,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102509,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 517554,
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
          "id": "efd2747039dbc9d46b4ef302d0eb2a4863e52d6f",
          "message": "refactor(llm): internalize transform option type",
          "timestamp": "2026-06-14T12:31:49+09:00",
          "tree_id": "541a3331d14b84661364c8a8875284461b713133",
          "url": "https://github.com/INONONO66/openomni/commit/efd2747039dbc9d46b4ef302d0eb2a4863e52d6f"
        },
        "date": 1781407940477,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 737.5556629100896,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 853.2986270510702,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1457.4884568300406,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.556245702000645,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 718.925541169111,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 472.83836511594,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2985.6469920884665,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2537.880976550463,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10174.564859090602,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5977.236268006185,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2713,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21680,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2506,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8157,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16014,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 749,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1622,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 14899,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 105669,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 521999,
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
          "id": "9994bad18b0f1ff85ba376f6ba46be740427f086",
          "message": "refactor(llm): remove agent retry dead surface",
          "timestamp": "2026-06-14T12:39:59+09:00",
          "tree_id": "0e72b38e3dbc21cf4a09120c5ce869786cffc388",
          "url": "https://github.com/INONONO66/openomni/commit/9994bad18b0f1ff85ba376f6ba46be740427f086"
        },
        "date": 1781408422870,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 776.1998354497877,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 893.4414573784697,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1645.13629783172,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 51.041551886844644,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 729.1040866173122,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 481.37556741872964,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3246.189703304595,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2663.4580248227544,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11790.137821268623,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6253.161205602351,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2498,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19663,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2451,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8425,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16220,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 829,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1581,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10807,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 107611,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 527579,
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
          "id": "d1764559b58cd254e2aac3aad23ca0667693aeec",
          "message": "refactor(llm): internalize processor helper types",
          "timestamp": "2026-06-14T12:49:49+09:00",
          "tree_id": "f937a8186dea101fcd1a06c2e28448c696231aee",
          "url": "https://github.com/INONONO66/openomni/commit/d1764559b58cd254e2aac3aad23ca0667693aeec"
        },
        "date": 1781409019572,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 726.4589662562254,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 809.6403490379546,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1550.8010328303342,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.46477094580584,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 629.8841143864396,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.8120756981024,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2825.8589917484833,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2604.89421724413,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9121.16390003595,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6165.911276897226,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2463,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 24390,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2419,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8269,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15748,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 779,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1525,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10730,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101426,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 519207,
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
          "id": "69c8b774e8a1c9bf4f49961924a6f5e499e89b0f",
          "message": "refactor(openomni): remove app connector registry remove export",
          "timestamp": "2026-06-14T12:57:30+09:00",
          "tree_id": "38d4625d6857964fb99f458b582bb642544955c0",
          "url": "https://github.com/INONONO66/openomni/commit/69c8b774e8a1c9bf4f49961924a6f5e499e89b0f"
        },
        "date": 1781409479427,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 734.3017902250825,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 853.1837998788957,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1431.6337255913227,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.15337672385734,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 669.111493991392,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 535.909067524139,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3158.0933522814425,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2508.142007975574,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10488.003880439877,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5906.930301240594,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2317,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 22227,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2540,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8534,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15980,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 753,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1591,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11015,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103534,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 520442,
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
          "id": "9e2da1726ce5c0ff249760783b97ed03884f74e6",
          "message": "refactor(openomni): keep resident prompt helpers internal (#356)",
          "timestamp": "2026-06-14T13:15:32+09:00",
          "tree_id": "2ad671d240e5121cb803ca09dbf93cca89d428ab",
          "url": "https://github.com/INONONO66/openomni/commit/9e2da1726ce5c0ff249760783b97ed03884f74e6"
        },
        "date": 1781410560044,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 822.9344783034913,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 832.3590531122961,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1290.2161353162533,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.11848127749961,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 591.7939270560248,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445.06781049020356,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2712.695258246473,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2487.36919212019,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8870.064750753607,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5843.930691912455,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2248,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20746,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2290,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7794,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14882,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 736,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1597,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11092,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103313,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 554163,
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
          "id": "ab338707f24524c0c7d3285b25745a4a770f45e8",
          "message": "refactor(scripts): remove orphan experiment runners\n\nRemove unreferenced root experiment scripts that were not wired into CI, package scripts, docs, runtime code, or tests.",
          "timestamp": "2026-06-14T13:28:16+09:00",
          "tree_id": "523ff638d3340b2dca307b319462c1e837b52564",
          "url": "https://github.com/INONONO66/openomni/commit/ab338707f24524c0c7d3285b25745a4a770f45e8"
        },
        "date": 1781411324620,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 578.7524220712287,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 676.2339698939651,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1209.8225096178837,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 39.372693942046745,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 509.3134871118622,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 353.2527447682493,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2372.381191876881,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2029.4015748032298,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 7624.585391887066,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 4954.391181571166,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1766,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 15653,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 1811,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 6593,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 12440,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 603,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1195,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 9845,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 78712,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 406881,
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
          "id": "c3e8e9e99b3387df0f80b65fc5703f104682b03a",
          "message": "refactor(openomni): internalize worker child runtime type\n\nKeep WorkerChildRuntimeConfig as an implementation detail while preserving the exported worker subagent runtime helpers.",
          "timestamp": "2026-06-14T13:38:08+09:00",
          "tree_id": "33e681e325bec030d6a3ba4442a4309a0976acaf",
          "url": "https://github.com/INONONO66/openomni/commit/c3e8e9e99b3387df0f80b65fc5703f104682b03a"
        },
        "date": 1781411922345,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 695.6923933157443,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 808.0008403154015,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1400.070353517684,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.28518418853892,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 649.2941680626344,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446.8560684937566,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2947.5409555814117,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2498.8145380943397,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9922.313591269836,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5877.003291020999,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2276,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20488,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2427,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7867,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15250,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 711,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1593,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10755,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101409,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 512522,
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
          "id": "43219d13a26cbd3263f93dca19a140cbc518b4d5",
          "message": "refactor(openomni): remove background limits policy alias\n\nRemove deprecated BackgroundLimitsPolicy compatibility alias while preserving canonical BackgroundLimitsMiddleware.",
          "timestamp": "2026-06-14T13:51:21+09:00",
          "tree_id": "d582965eb90386bddc108a10de5266854cc11d45",
          "url": "https://github.com/INONONO66/openomni/commit/43219d13a26cbd3263f93dca19a140cbc518b4d5"
        },
        "date": 1781412715986,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 781.8469465141987,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 885.128811548958,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1471.0866296946883,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 51.0268258159618,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 643.7320544594769,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 559.1179677278518,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3029.533581750212,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2661.3066318928672,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9824.926318891827,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6235.2209751852615,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2140,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20089,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2536,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8324,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16128,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 751,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1630,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11348,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 107977,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 576257,
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
          "id": "dd6331f888838744231ece23f462439162ac6f59",
          "message": "refactor(agent): remove deprecated policy config fields",
          "timestamp": "2026-06-14T14:08:24+09:00",
          "tree_id": "b101c843bc04894294b8d8c6945ad8ee4591e226",
          "url": "https://github.com/INONONO66/openomni/commit/dd6331f888838744231ece23f462439162ac6f59"
        },
        "date": 1781413732862,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 691.0455742213044,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 792.6218334867424,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1302.470785902479,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.82363459968827,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 590.3239275320152,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 444.6781022935981,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2707.234169847461,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2505.5380837847047,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8676.628058302482,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5819.171476783207,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2329,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21508,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2372,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7842,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14911,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 734,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1575,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10987,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 106409,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 520139,
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
          "id": "cfde7cefd7fc3e01494a73e751999cd48936ee7e",
          "message": "refactor(protocol): remove agent model ref alias\n\nRemove the deprecated AgentProfile.ModelRef compatibility alias and use the canonical Model.Ref schema directly in AgentProfile.Definition.",
          "timestamp": "2026-06-14T14:24:53+09:00",
          "tree_id": "f0dbe57bb14368b6454e5ccc906bf479b4abf5b6",
          "url": "https://github.com/INONONO66/openomni/commit/cfde7cefd7fc3e01494a73e751999cd48936ee7e"
        },
        "date": 1781414725109,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 721.772461529581,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 821.9063935757176,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1466.4498768181427,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.15600288779072,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 648.3699119519669,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445.7814475361653,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2825.7586255612646,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2491.6844072355407,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9345.885140186343,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5822.2396367022575,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2347,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20544,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2357,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8033,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15232,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 704,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1582,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11114,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102853,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 540899,
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
          "id": "fd445404d865aaf8b4729cd818263369aa95c942",
          "message": "refactor(session): remove test storage facade\n\nRemove Session.storage and Session.messages test compatibility facades and migrate tests to canonical Storage APIs.",
          "timestamp": "2026-06-14T14:41:57+09:00",
          "tree_id": "7e7f7f44afa7e2c6f310722dffff83d99596401f",
          "url": "https://github.com/INONONO66/openomni/commit/fd445404d865aaf8b4729cd818263369aa95c942"
        },
        "date": 1781415744622,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 765.5915340918879,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 892.6866686902656,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1573.3993153881522,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.83891493544684,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 671.57506178479,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 509.18142102102905,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3108.7282081570806,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2671.2936478256584,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10536.885259719465,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6290.499024973393,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2376,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19674,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2541,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8509,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16260,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 734,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1542,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 12899,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 114553,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 588954,
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
          "id": "dcf079122e8dcc98eb9f1f6be3f560107fbfe6be",
          "message": "refactor(session): trim drizzle schema surface",
          "timestamp": "2026-06-14T15:05:01+09:00",
          "tree_id": "72261ef53e4125205519bc332c6e9f8633cb7360",
          "url": "https://github.com/INONONO66/openomni/commit/dcf079122e8dcc98eb9f1f6be3f560107fbfe6be"
        },
        "date": 1781417130329,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 775.5075379222617,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 817.2684559371058,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1411.9010264447052,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.37080379102574,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 657.658007576162,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 478.53483241783624,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2911.9325607125857,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2614.0879623577844,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9918.11653277865,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6201.632992248121,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2345,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19573,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2510,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8246,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15690,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 756,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1541,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11106,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102698,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 539120,
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
          "id": "66680c414d1f801e51248697b97da51289f7c5b9",
          "message": "refactor(openomni): trim effective authority helper surface",
          "timestamp": "2026-06-14T15:19:54+09:00",
          "tree_id": "2de8933582e59248510d3c79330ef182cb3acdf8",
          "url": "https://github.com/INONONO66/openomni/commit/66680c414d1f801e51248697b97da51289f7c5b9"
        },
        "date": 1781418023697,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 774.4631201498829,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 930.2328930233349,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1461.8142495873049,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.57674900520996,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 673.1336438721817,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446.59945068442136,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2955.7605296600927,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2586.130779973116,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9779.613534128654,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6194.620230426083,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2226,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 18929,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2402,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8322,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15712,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 786,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1633,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11012,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103618,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 548551,
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
          "id": "f303261af8cae401098e12f324cbfa2f6397daf1",
          "message": "refactor(openomni): split read back executor internals\n\n* refactor(openomni): split read back executor internals\n\n* fix(openomni): preserve read back transport failures\n\n* fix(openomni): pin read back network targets",
          "timestamp": "2026-06-14T16:04:40+09:00",
          "tree_id": "1dcb29beeb00055fac45ba130985b40e460caa74",
          "url": "https://github.com/INONONO66/openomni/commit/f303261af8cae401098e12f324cbfa2f6397daf1"
        },
        "date": 1781420712047,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 688.2291106048606,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 778.0580505112312,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1254.478078153579,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.91432740102665,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 584.1968558676441,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 443.0273124786669,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2786.513820775506,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2490.322193445377,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8636.08126079432,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5893.218044669761,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2219,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20223,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2404,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8037,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15809,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 722,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1578,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10695,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101806,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 513792,
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
          "id": "33d22ef1903e26e37c0952a36af54d27f98a6213",
          "message": "refactor(openomni): remove unused skill loader discover",
          "timestamp": "2026-06-14T16:16:54+09:00",
          "tree_id": "574df268217d8584a677f09c6047141640a824af",
          "url": "https://github.com/INONONO66/openomni/commit/33d22ef1903e26e37c0952a36af54d27f98a6213"
        },
        "date": 1781421437318,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 711.583781629888,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 828.0308108870378,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1418.815314548246,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.551815330563926,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 682.1211443226498,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 476.5725818750142,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3199.1813295793127,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2612.706858262724,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9511.27258892874,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6179.883512543966,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2258,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19268,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2558,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8705,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16519,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 836,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1484,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10811,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103287,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 528407,
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
          "id": "cafb56fe752c83f2c50e9ecca9ccc6b3d16852bc",
          "message": "refactor(openomni): remove unused workspace lock surface",
          "timestamp": "2026-06-14T16:30:42+09:00",
          "tree_id": "a70fab00d6408b5d7f523605a5ab0f1463b3937c",
          "url": "https://github.com/INONONO66/openomni/commit/cafb56fe752c83f2c50e9ecca9ccc6b3d16852bc"
        },
        "date": 1781422272126,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 808.9076716496444,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 886.0412294649234,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1512.725694601882,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.19467040196464,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 617.2961783242904,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446.0694617296301,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2969.962222684193,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2512.198010349904,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9627.725714835227,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5895.3607262861915,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2538,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20944,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2419,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8077,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15280,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 716,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1716,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10897,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101740,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 517724,
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
          "id": "3db37aeb89991e9aad56749789f2ac2ed96a45b5",
          "message": "refactor(openomni): internalize injection queue events",
          "timestamp": "2026-06-14T16:46:21+09:00",
          "tree_id": "42e84c59c12fdfd2b984e5a1ec64fefe06ee0371",
          "url": "https://github.com/INONONO66/openomni/commit/3db37aeb89991e9aad56749789f2ac2ed96a45b5"
        },
        "date": 1781423204517,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 722.7056204786003,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 841.7674876683518,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1679.5097239703507,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 51.63921801714018,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 662.9348536577513,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.4850048328483,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2964.3367422554948,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2634.019649677394,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9474.019988632292,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6338.684033719096,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2267,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19179,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2395,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8268,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15711,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 770,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1623,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11406,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103478,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 526453,
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
          "id": "aea8438d4807a43eba455a679b407c69dd7c73ea",
          "message": "refactor(openomni): internalize effective authority types",
          "timestamp": "2026-06-14T16:59:00+09:00",
          "tree_id": "ef1080e54d5583ba0d1ff12aae797b55395becd0",
          "url": "https://github.com/INONONO66/openomni/commit/aea8438d4807a43eba455a679b407c69dd7c73ea"
        },
        "date": 1781423966233,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 722.6374383952929,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 822.4850924883996,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1348.5535642040893,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.983164522808494,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 604.2661413611307,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450.4766654052974,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2813.2366459451146,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2502.335860671022,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 12314.584533924091,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6152.507690416073,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2278,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20889,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2496,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8026,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15413,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 746,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1598,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10823,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101956,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 514071,
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
          "id": "b7680edf513206049f4919a0d5539128ea7165bd",
          "message": "refactor(openomni): internalize cron runner types",
          "timestamp": "2026-06-14T17:10:46+09:00",
          "tree_id": "039ff2c5d14a8259e27daca6e6e5d5d64b5e8749",
          "url": "https://github.com/INONONO66/openomni/commit/b7680edf513206049f4919a0d5539128ea7165bd"
        },
        "date": 1781424669577,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 752.5458636544424,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 844.9187022097138,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1491.1786257495278,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.490810550153334,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 718.4636385842774,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.6873273612076,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3127.3512837349895,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2605.2154226908565,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10021.739152219889,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6141.117968558443,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2513,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19428,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2675,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 9934,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 19305,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 720,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1513,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11116,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 110623,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 532520,
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
          "id": "47e4d3df4b304cadd0da05d9e872acc19ddf5731",
          "message": "refactor(openomni): internalize tool runtime policy types",
          "timestamp": "2026-06-14T17:25:28+09:00",
          "tree_id": "2641a157b113e9e3a881ed8322949f6b19f10fa4",
          "url": "https://github.com/INONONO66/openomni/commit/47e4d3df4b304cadd0da05d9e872acc19ddf5731"
        },
        "date": 1781425558466,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 785.9501002082833,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 794.3575559228593,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1300.2609481460338,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 46.93872011297397,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 614.3967756602325,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 444.72447622727185,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2835.237815769147,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2482.0135269299276,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9408.737510584351,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5934.423951101555,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2220,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20167,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2758,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7973,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 18689,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 877,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1760,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11250,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101740,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 514022,
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
          "id": "669da3898fdc50fd671b93ea163b4df14897147a",
          "message": "refactor(openomni): internalize session resolver result type\n\n* refactor(openomni): internalize session resolver result type\n\n* refactor(openomni): preserve session resolver result shape",
          "timestamp": "2026-06-14T17:44:49+09:00",
          "tree_id": "f42687c69769605952097272ba52b1d18fde3c41",
          "url": "https://github.com/INONONO66/openomni/commit/669da3898fdc50fd671b93ea163b4df14897147a"
        },
        "date": 1781426716013,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 700.7665047895471,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 810.8556520469424,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1341.5830102363827,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47.053630774893946,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 621.6100153536873,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 443.04587725007053,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2889.2168976749017,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2508.4867054634688,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10440.69951973285,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5879.143915343531,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2283,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20569,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2721,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7895,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14895,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 744,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1637,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11092,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102608,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 515175,
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
          "id": "18301b74fdf380780aaf29d4d8785506f7072f71",
          "message": "refactor(openomni): internalize profile middleware config",
          "timestamp": "2026-06-14T17:57:14+09:00",
          "tree_id": "943fb20b45935c6429423cdb518f7192b83221f8",
          "url": "https://github.com/INONONO66/openomni/commit/18301b74fdf380780aaf29d4d8785506f7072f71"
        },
        "date": 1781427464916,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 760.4080481183892,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 910.3540346659856,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1684.7113784155679,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.56243278103042,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 743.27730786386,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447.6643910431008,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3472.2537500000626,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2644.4995107761915,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11486.65391683947,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6223.194784990062,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2237,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20438,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2586,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8528,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16379,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 794,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1571,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10949,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103595,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 526642,
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
          "id": "7b10c649758f07dcf62c89cfed96f7738819b0e3",
          "message": "refactor(openomni): remove policy resolver default export (#374)",
          "timestamp": "2026-06-14T18:10:50+09:00",
          "tree_id": "617f23b5f35bd0433e042f5ccf0872662e7e6101",
          "url": "https://github.com/INONONO66/openomni/commit/7b10c649758f07dcf62c89cfed96f7738819b0e3"
        },
        "date": 1781428287367,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 747.129738654767,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 883.6140918247322,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1536.97261116182,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.71943472970244,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 757.6548144892889,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 511.58685943193086,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3294.865572798118,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2796.7290320775155,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 13824.672380427235,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 7917.74940617445,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2216,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19955,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2812,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8318,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16228,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 749,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1509,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10764,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104805,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 533445,
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
          "id": "b1447e6c65144df1d0ebc0a20b06d569a691a9ef",
          "message": "refactor(openomni): internalize ingress authority types (#375)",
          "timestamp": "2026-06-14T18:24:08+09:00",
          "tree_id": "ab8e7b73a275607edf0c670329f689f69e32ac9a",
          "url": "https://github.com/INONONO66/openomni/commit/b1447e6c65144df1d0ebc0a20b06d569a691a9ef"
        },
        "date": 1781429072899,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 424.9346664910302,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 483.9389415306124,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 813.2378543661824,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 32.592696889269675,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 413.1526140091262,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 236.10593121290907,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 1826.1093458969215,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 1252.0113181090971,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 5041.966622970864,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 3003.7048929206244,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1405,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 11193,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 1433,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 5385,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 10078,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 417,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 896,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 6354,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 59474,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 301630,
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
          "id": "70c0b92d1dc43c59a5ba0cc0cdff38ccf6f70f37",
          "message": "refactor(openomni): internalize background launch types (#376)\n\n* refactor(openomni): internalize background launch types\n\n* chore(openomni): rerun background launch benchmarks",
          "timestamp": "2026-06-15T01:00:10+09:00",
          "tree_id": "abff7664e363520c45c3ad8928b4e29a7eb1eff7",
          "url": "https://github.com/INONONO66/openomni/commit/70c0b92d1dc43c59a5ba0cc0cdff38ccf6f70f37"
        },
        "date": 1781452836468,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 709.7918615626805,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 870.8191579221859,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1352.7344741293027,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50.52100183141217,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 637.0701348674171,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 442.5943764080042,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2822.4944884552647,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2873.0386129230396,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9844.987399095055,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6514.494365187642,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2240,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19295,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2415,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8229,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15762,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 757,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1494,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11373,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 109835,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 530109,
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
          "id": "e547d5f1018e8c21c4e3b873acf37933d8463c2d",
          "message": "refactor(openomni): internalize subagent spawn policy types (#377)",
          "timestamp": "2026-06-15T01:04:07+09:00",
          "tree_id": "fb9cc904c666034d7cbef3ad1614c5da12b8bb8c",
          "url": "https://github.com/INONONO66/openomni/commit/e547d5f1018e8c21c4e3b873acf37933d8463c2d"
        },
        "date": 1781453077725,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "compaction/20-messages",
            "value": 870.088583584917,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 876.4407312949986,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1463.0662901785527,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49.82754785679821,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 664.171999946828,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450.70106410317715,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3098.094057871775,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2606.650088624852,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9606.63255903278,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6176.643258601728,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2223,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19272,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2499,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8453,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16286,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 730,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1503,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11576,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103120,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 516001,
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
          "id": "5e359f01285fb45abf98fd4509f9a47a12579503",
          "message": "chore: stabilize benchmark gate with repeated runs (#378)",
          "timestamp": "2026-06-15T01:11:46+09:00",
          "tree_id": "6d3232bccc5d51d2e9090f469268614fd467b748",
          "url": "https://github.com/INONONO66/openomni/commit/5e359f01285fb45abf98fd4509f9a47a12579503"
        },
        "date": 1781453566004,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 444,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 643,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6211,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9857,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2592,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2888,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2402,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15739,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8262,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 819,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 719,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1420,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1552,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 773,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19384,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2247,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10771,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103039,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 524302,
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
          "id": "a70effd1a3819e06b5131e4d8264c311b2325bf9",
          "message": "refactor(openomni): move connector endpoint runtime to server\n\nMoves connector endpoint runtime ownership to apps/server, keeps packages/openomni focused on dispatch orchestration, and removes the legacy local-cli worker handler surface.",
          "timestamp": "2026-06-15T01:45:12+09:00",
          "tree_id": "ec41e478c53dc0d48d761d9938cf3285a468fe6e",
          "url": "https://github.com/INONONO66/openomni/commit/a70effd1a3819e06b5131e4d8264c311b2325bf9"
        },
        "date": 1781455572583,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 701,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6209,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10151,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2599,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3125,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2477,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16056,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8457,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 861,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 748,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1510,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1559,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 832,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19565,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2265,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10836,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104049,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 525368,
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
          "id": "1a2327134447d987a1fea9773b244941fb6fef9b",
          "message": "refactor(server): own app connector registry\n\nMoves server-specific connector definitions, discovery, and registry lifecycle out of @openomni/openomni so packages keep only shared contracts and dispatch orchestration.",
          "timestamp": "2026-06-15T01:52:03+09:00",
          "tree_id": "7c152d8c6ce49eb912348b30ba13974c3a000a3c",
          "url": "https://github.com/INONONO66/openomni/commit/1a2327134447d987a1fea9773b244941fb6fef9b"
        },
        "date": 1781455983276,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 669,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6195,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10246,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2612,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3137,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2459,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16012,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8328,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 852,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 735,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1483,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1558,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 801,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19574,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2248,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11017,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102761,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 528872,
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
          "id": "794021e8355334b9a4e664faa9e2ee59724d5051",
          "message": "refactor(coordinator): rename worker supervision internals\n\nRenames the live coordinator supervision internals away from stale worker-pool terminology while keeping historical fixed-pool ADR references intact.",
          "timestamp": "2026-06-15T01:59:11+09:00",
          "tree_id": "da6442cfb658e6063795144bcf0193d826398311",
          "url": "https://github.com/INONONO66/openomni/commit/794021e8355334b9a4e664faa9e2ee59724d5051"
        },
        "date": 1781456411106,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 669,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6169,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9430,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2609,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2959,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2476,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16135,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8346,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 844,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 740,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1475,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1541,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 795,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19389,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2251,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10998,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103852,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 538409,
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
          "id": "179ebe30ee961fa6d70dd1684265335b28340f37",
          "message": "refactor(agent): split policy effect composition",
          "timestamp": "2026-06-15T03:07:40+09:00",
          "tree_id": "64880cff82299d22f2842723acddd47c6278ab6e",
          "url": "https://github.com/INONONO66/openomni/commit/179ebe30ee961fa6d70dd1684265335b28340f37"
        },
        "date": 1781460520583,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 608,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5865,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9258,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2492,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2818,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2379,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15139,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8101,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 812,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 693,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1323,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1585,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 731,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20783,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2330,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11000,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103870,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 533339,
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
          "id": "c08a3b65b22e34367b168e5a7d37a3a30ffdeff1",
          "message": "refactor(openomni): split extension manager internals (#383)",
          "timestamp": "2026-06-15T03:26:33+09:00",
          "tree_id": "781a0c2a090b71412257c5d7b6deca8dc9213488",
          "url": "https://github.com/INONONO66/openomni/commit/c08a3b65b22e34367b168e5a7d37a3a30ffdeff1"
        },
        "date": 1781461653232,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 449,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 677,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6247,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10122,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2620,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3004,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2553,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 17009,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8890,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 844,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 724,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1512,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1557,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 783,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19367,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2259,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11011,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102762,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 527455,
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
          "id": "e538c1dc5d825a7c084a374f9a9a1c8ec514375b",
          "message": "refactor(openomni): split subagent runtime internals (#384)",
          "timestamp": "2026-06-15T03:52:22+09:00",
          "tree_id": "453cd126dccaefe6969afd6b86f1ceb8db2fa81c",
          "url": "https://github.com/INONONO66/openomni/commit/e538c1dc5d825a7c084a374f9a9a1c8ec514375b"
        },
        "date": 1781463200162,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 356,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 579,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 4884,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8563,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2044,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2669,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 1872,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 12703,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 6768,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 703,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 581,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1305,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 39,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1214,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 613,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 15731,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1766,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8533,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 80045,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 408540,
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
          "id": "31d0387fc9497c9ccaf592f699af0cc079ad57c4",
          "message": "refactor(agent): keep effect record helpers internal (#385)",
          "timestamp": "2026-06-15T04:11:28+09:00",
          "tree_id": "0df1223d640b16bbb0704245c77b728e7e3a987c",
          "url": "https://github.com/INONONO66/openomni/commit/31d0387fc9497c9ccaf592f699af0cc079ad57c4"
        },
        "date": 1781464344036,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 451,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 657,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5895,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10363,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2559,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3012,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2452,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15463,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8090,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 832,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 715,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1423,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1584,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 728,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20818,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2283,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10827,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101922,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 515556,
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
          "id": "aa1717e064bbfd6cd1134c2c7a900615edebd710",
          "message": "refactor(openomni): keep connector executor kind internal (#386)",
          "timestamp": "2026-06-15T04:23:35+09:00",
          "tree_id": "5c7878412f7357893e4f7098a3fa6766cffb337c",
          "url": "https://github.com/INONONO66/openomni/commit/aa1717e064bbfd6cd1134c2c7a900615edebd710"
        },
        "date": 1781465074839,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 721,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6272,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10660,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2610,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3289,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2492,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16402,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8507,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 867,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 741,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1558,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1531,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 787,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19945,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2252,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11039,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102559,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 525079,
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
          "id": "a25dd7a65ad2a995045c42ca94f64df91bcb5cb4",
          "message": "refactor(openomni): remove unused worker executor helper (#387)",
          "timestamp": "2026-06-15T04:34:50+09:00",
          "tree_id": "b546bed3eea0caacc8d3a0f54e9f54f37470aa78",
          "url": "https://github.com/INONONO66/openomni/commit/a25dd7a65ad2a995045c42ca94f64df91bcb5cb4"
        },
        "date": 1781465752971,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 599,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5870,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9288,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2501,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2721,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2393,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15173,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7879,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 798,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 685,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1296,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1597,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 742,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20292,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2250,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10963,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101388,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 535685,
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
          "id": "ec2af2c0bdebea6a5b2c5b18224b8bc94ed43651",
          "message": "refactor(agent): keep policy boundary type internal (#388)",
          "timestamp": "2026-06-15T04:45:13+09:00",
          "tree_id": "8f27d78b52f9b545e6834c85b3172a92ddc41c27",
          "url": "https://github.com/INONONO66/openomni/commit/ec2af2c0bdebea6a5b2c5b18224b8bc94ed43651"
        },
        "date": 1781466378944,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 671,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6233,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10528,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2608,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3042,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2505,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16319,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8375,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 833,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 722,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1457,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1530,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 785,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19531,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2263,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10869,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102541,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 521147,
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
          "id": "31db8f53ebf4ceccb9f36b9f48dd5957d9dce08d",
          "message": "refactor(server): keep connector log path helper internal",
          "timestamp": "2026-06-15T05:03:30+09:00",
          "tree_id": "f772cffa056ee3968362c60744af069826532816",
          "url": "https://github.com/INONONO66/openomni/commit/31db8f53ebf4ceccb9f36b9f48dd5957d9dce08d"
        },
        "date": 1781467473412,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 638,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5867,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9638,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2508,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3004,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2411,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15478,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8118,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 826,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 702,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1368,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1609,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 735,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20221,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2260,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10889,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102005,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 516279,
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
          "id": "ff412be6e4d3b42cf99148462c6bf76f9f0d0a8f",
          "message": "refactor(openomni): keep extension audit helpers internal",
          "timestamp": "2026-06-15T05:17:42+09:00",
          "tree_id": "d815ecc953f5199fef581fa7223acc00a425340b",
          "url": "https://github.com/INONONO66/openomni/commit/ff412be6e4d3b42cf99148462c6bf76f9f0d0a8f"
        },
        "date": 1781468325434,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 627,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5875,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9652,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2506,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2864,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2413,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15253,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7910,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 836,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 720,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1354,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1580,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 740,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20635,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2301,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10831,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102339,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 513742,
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
          "id": "36bc1c59e0713e645673154faadfee66c3218706",
          "message": "refactor(server): keep connector driver input internal",
          "timestamp": "2026-06-15T05:29:18+09:00",
          "tree_id": "fa52361c19467eb0b901934b9f3c21f4265a2ebe",
          "url": "https://github.com/INONONO66/openomni/commit/36bc1c59e0713e645673154faadfee66c3218706"
        },
        "date": 1781469011483,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 351,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 537,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 4818,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8219,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2040,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2522,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 1841,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 12453,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 6580,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 692,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 573,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1222,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 39,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1190,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 624,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 15342,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1755,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8407,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 78102,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 395572,
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
          "id": "2074eb00041bd3217b1cfb752fe2d0aefa7a0d1a",
          "message": "refactor(server): keep connector registry options internal",
          "timestamp": "2026-06-15T05:40:20+09:00",
          "tree_id": "ce5c9e78cb70de2dbd769e8e41abe774e3f77054",
          "url": "https://github.com/INONONO66/openomni/commit/2074eb00041bd3217b1cfb752fe2d0aefa7a0d1a"
        },
        "date": 1781469673028,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 348,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 507,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 4817,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 7592,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2020,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2321,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 1761,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 12105,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 6399,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 634,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 541,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1132,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 38,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1193,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 633,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 15257,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1749,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8330,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 77960,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 394600,
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
          "id": "fa2b9259efe1884fb4842325cc20fb750a549e16",
          "message": "refactor(server): keep connector discovery helpers internal",
          "timestamp": "2026-06-15T05:51:52+09:00",
          "tree_id": "991bbf5bb8477e2a4db120e5884f22b4c3037ccf",
          "url": "https://github.com/INONONO66/openomni/commit/fa2b9259efe1884fb4842325cc20fb750a549e16"
        },
        "date": 1781470365501,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 458,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 673,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6372,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9712,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2602,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3132,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2414,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16199,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8339,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 846,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 721,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1452,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1520,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 774,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19195,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2239,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10845,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102788,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 515611,
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
          "id": "3d052b8ff173ada25e9acb3c1c8fd765e8f3e929",
          "message": "refactor(server): trim connector discovery barrel types",
          "timestamp": "2026-06-15T05:59:41+09:00",
          "tree_id": "9263aad2f50212cc44aa8531f4c5c0e98b9be527",
          "url": "https://github.com/INONONO66/openomni/commit/3d052b8ff173ada25e9acb3c1c8fd765e8f3e929"
        },
        "date": 1781470860174,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 586,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 632,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6264,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9484,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2693,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2900,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2577,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16039,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8375,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 814,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 724,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1315,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 51,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1587,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 745,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19496,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2118,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11295,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 106758,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 541355,
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
          "id": "cfd4682f3cb0632b8c72991d753277a87476c2fc",
          "message": "refactor(server): trim connector barrel values",
          "timestamp": "2026-06-15T06:10:09+09:00",
          "tree_id": "cd5159e67561cebf8a0295ac9b8dc801846cfa1b",
          "url": "https://github.com/INONONO66/openomni/commit/cfd4682f3cb0632b8c72991d753277a87476c2fc"
        },
        "date": 1781471462802,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 653,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6208,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9412,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2593,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2977,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2439,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15748,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8357,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 833,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 715,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1414,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1528,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 755,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19068,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2257,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11005,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103223,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 543185,
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
          "id": "da59d1f171fe40fa38984821f6e9422ba7ee1ae5",
          "message": "refactor(session): keep app connector removal internal",
          "timestamp": "2026-06-15T06:19:40+09:00",
          "tree_id": "d88657f919569b571dbe8890063732a973c7e662",
          "url": "https://github.com/INONONO66/openomni/commit/da59d1f171fe40fa38984821f6e9422ba7ee1ae5"
        },
        "date": 1781472035568,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 653,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5895,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10050,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2534,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3018,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2444,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15576,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8049,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 837,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 721,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1414,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1591,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 729,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21205,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2298,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10971,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103152,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 533366,
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
          "id": "d5591cfd06cc45930e98d08615c28f9a862e3934",
          "message": "refactor(tooling): configure knip workspaces",
          "timestamp": "2026-06-15T06:34:04+09:00",
          "tree_id": "59489573555b9a10bb7ba216c5b268589cdb42e5",
          "url": "https://github.com/INONONO66/openomni/commit/d5591cfd06cc45930e98d08615c28f9a862e3934"
        },
        "date": 1781472901494,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 352,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 526,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 4815,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 7956,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2026,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2423,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 1816,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 12168,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 6534,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 665,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 561,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1213,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 39,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1191,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 636,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 15330,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1786,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8417,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 78829,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 397107,
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
          "id": "78a08a950deb1dbbd4be4283b717a66a606dbc2e",
          "message": "refactor(protocol): keep policy helpers internal",
          "timestamp": "2026-06-15T06:48:32+09:00",
          "tree_id": "dfb362c6abb2593f6d10f9e05dc7e958b61542e6",
          "url": "https://github.com/INONONO66/openomni/commit/78a08a950deb1dbbd4be4283b717a66a606dbc2e"
        },
        "date": 1781473768222,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 667,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6170,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9895,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2602,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3056,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2464,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15987,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8261,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 832,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 723,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1452,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1536,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 786,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19532,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2248,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10821,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102832,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 521977,
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
          "id": "1e3f4c96cddf1efeb1f9f86d4f13448f0cee6de9",
          "message": "refactor(session): keep bus persistence options internal",
          "timestamp": "2026-06-15T06:59:02+09:00",
          "tree_id": "10b14af03b5e9827ff9d51be610cce23d4bd8cb7",
          "url": "https://github.com/INONONO66/openomni/commit/1e3f4c96cddf1efeb1f9f86d4f13448f0cee6de9"
        },
        "date": 1781474403284,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 449,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 599,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5849,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9278,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2508,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2766,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2398,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15307,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7934,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 798,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 693,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1318,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1569,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 704,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20898,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2283,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10907,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101512,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 528599,
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
          "id": "c8b69ea3b7ecbfb2a4ad3af1b20cdd4922365dc7",
          "message": "refactor(session): keep bus query record types internal",
          "timestamp": "2026-06-15T07:09:48+09:00",
          "tree_id": "8f1a527b152df1e918dc88850b5c0c2990fff670",
          "url": "https://github.com/INONONO66/openomni/commit/c8b69ea3b7ecbfb2a4ad3af1b20cdd4922365dc7"
        },
        "date": 1781475044960,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 240,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 509,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 3015,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 5767,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 1278,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2067,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 1569,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 10632,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 5581,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 498,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 429,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 901,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 33,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 890,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 434,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 11343,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1338,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 6553,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 61485,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 310108,
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
          "id": "aabab9703f850e5d7e03b07cdf25a337cf291a5d",
          "message": "refactor(session): keep surface key parse types internal",
          "timestamp": "2026-06-15T07:21:38+09:00",
          "tree_id": "d0ee5ec697cafc20ab8af458ec5b4a1f349993e6",
          "url": "https://github.com/INONONO66/openomni/commit/aabab9703f850e5d7e03b07cdf25a337cf291a5d"
        },
        "date": 1781475755398,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 449,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 641,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5873,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9837,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2507,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3023,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2427,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15528,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8084,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 846,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 721,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1435,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1583,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 730,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20653,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2296,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10935,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102807,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 518009,
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
          "id": "c0ce77662bbddcabcf67e8e8bdf46927406db727",
          "message": "refactor(session): keep recovered message type internal",
          "timestamp": "2026-06-15T07:32:30+09:00",
          "tree_id": "298d09ac867b86982a8de0614211d267cd40669a",
          "url": "https://github.com/INONONO66/openomni/commit/c0ce77662bbddcabcf67e8e8bdf46927406db727"
        },
        "date": 1781476412058,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 611,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5869,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9320,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2502,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2842,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2379,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15199,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7919,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 807,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 688,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1339,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1597,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 724,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20250,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2255,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11063,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101993,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 535120,
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
          "id": "1c6bbaf4874bbe371b75568713823c9694b9c18f",
          "message": "refactor(session): keep snapshot events internal",
          "timestamp": "2026-06-15T07:40:37+09:00",
          "tree_id": "51955af3c4574e2ce69017215fc98de8fd73d2a5",
          "url": "https://github.com/INONONO66/openomni/commit/1c6bbaf4874bbe371b75568713823c9694b9c18f"
        },
        "date": 1781476897015,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 507,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 633,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6234,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9388,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2635,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2841,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2571,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15901,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8389,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 819,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 717,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1328,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 51,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1638,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 742,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19822,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2111,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11265,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 106522,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 546682,
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
          "id": "3759b1c4ea8362da4d4dcc41756e09b89a273570",
          "message": "refactor(session): remove dead snapshot removal api",
          "timestamp": "2026-06-15T07:50:16+09:00",
          "tree_id": "862988bbb0fe1f72f1fd70fd6f4332a5a90f8b23",
          "url": "https://github.com/INONONO66/openomni/commit/3759b1c4ea8362da4d4dcc41756e09b89a273570"
        },
        "date": 1781477474688,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 444,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 580,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5864,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9165,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2492,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2658,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2300,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14716,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7793,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 786,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 680,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1274,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1582,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 710,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20041,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2271,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10695,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 100830,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 512836,
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
          "id": "677d01c58d9b5d5e07a21116963b1ccc171831f0",
          "message": "refactor(openomni): keep subagent runtime types internal",
          "timestamp": "2026-06-15T08:07:18+09:00",
          "tree_id": "899f45a9cf7d80bec9a74af157a7bf84fd8f7c08",
          "url": "https://github.com/INONONO66/openomni/commit/677d01c58d9b5d5e07a21116963b1ccc171831f0"
        },
        "date": 1781478496211,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 452,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 662,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6194,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9840,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2597,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3007,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2472,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16081,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8374,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 841,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 714,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1459,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1513,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 777,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19228,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2254,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10728,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102289,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 520052,
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
          "id": "373c5ed0c1382a56bc2bac4511b796742df7f6c5",
          "message": "refactor(openomni): remove dead extension manager api",
          "timestamp": "2026-06-15T08:30:12+09:00",
          "tree_id": "c6113e8db6a9bf1726a1953df5272d72111bc729",
          "url": "https://github.com/INONONO66/openomni/commit/373c5ed0c1382a56bc2bac4511b796742df7f6c5"
        },
        "date": 1781479871941,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 647,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6241,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9485,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2612,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2909,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2398,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15783,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8249,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 836,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 728,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1453,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1550,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 798,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19266,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2259,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10855,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102226,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 521300,
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
          "id": "fa448801185f0b2c58fbfbf29cb6c6162f99034c",
          "message": "refactor(session): remove dead snapshot provider api",
          "timestamp": "2026-06-15T08:47:13+09:00",
          "tree_id": "9efc7d7f8517ea47c807aa03da4110789165b3bc",
          "url": "https://github.com/INONONO66/openomni/commit/fa448801185f0b2c58fbfbf29cb6c6162f99034c"
        },
        "date": 1781480893942,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 599,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5835,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9458,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2507,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2819,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2392,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15198,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7992,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 807,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 696,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1320,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1602,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 735,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20611,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2304,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11040,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102105,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 527817,
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
          "id": "6949e95d9a24daca70386748fb6f5fdb0c334f8e",
          "message": "refactor(session): remove dead channel grant accessors",
          "timestamp": "2026-06-15T08:56:32+09:00",
          "tree_id": "6f8c70037aee368ff63f311a5ece2e8748386791",
          "url": "https://github.com/INONONO66/openomni/commit/6949e95d9a24daca70386748fb6f5fdb0c334f8e"
        },
        "date": 1781481456477,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 691,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6268,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10345,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2699,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3045,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2492,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15993,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8456,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 843,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 738,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1528,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1542,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 751,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19655,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2319,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10856,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103021,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 521938,
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
          "id": "908133b01d4f990a79eb29ba40166b7c0c9495cc",
          "message": "refactor(session): remove dead blacklist accessors",
          "timestamp": "2026-06-15T09:06:19+09:00",
          "tree_id": "1d90183d8922f4e1837daf033fcbab395a217281",
          "url": "https://github.com/INONONO66/openomni/commit/908133b01d4f990a79eb29ba40166b7c0c9495cc"
        },
        "date": 1781482038588,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 714,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6167,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10334,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2622,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3189,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2519,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16190,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8385,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 862,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 734,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1519,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1557,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 782,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19946,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2276,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11038,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102627,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 540692,
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
          "id": "5f6bf32b6571fe16b1a231ad6641b7e8440a220b",
          "message": "refactor(session): remove dead pending ask surface",
          "timestamp": "2026-06-15T09:18:40+09:00",
          "tree_id": "e776fab2470f01ac6ef98cb6b21de881ec21db25",
          "url": "https://github.com/INONONO66/openomni/commit/5f6bf32b6571fe16b1a231ad6641b7e8440a220b"
        },
        "date": 1781482780766,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 444,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 601,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5848,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8853,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2496,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2757,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2350,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15042,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7957,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 791,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 691,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1308,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1582,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 744,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20420,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2234,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10791,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102885,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 521778,
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
          "id": "106c62a9c2d38bd9ed23d7d74b1f28df7c46edc2",
          "message": "refactor(session): remove dead pending interaction surface",
          "timestamp": "2026-06-15T09:29:23+09:00",
          "tree_id": "9519be8bd8a65acaea74c99b55d5ca920312fcde",
          "url": "https://github.com/INONONO66/openomni/commit/106c62a9c2d38bd9ed23d7d74b1f28df7c46edc2"
        },
        "date": 1781483423197,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 604,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5863,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8932,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2501,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2734,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2387,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15007,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7855,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 818,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 698,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1312,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1587,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 741,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20525,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2292,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11085,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101548,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 513751,
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
          "id": "f0c8160315c102e9e09e21f274d6dbe0506e3ae6",
          "message": "refactor(session): remove dead work item gate api",
          "timestamp": "2026-06-15T09:43:26+09:00",
          "tree_id": "27a04f5ed2f6446eaf9515de09f1f71a10754434",
          "url": "https://github.com/INONONO66/openomni/commit/f0c8160315c102e9e09e21f274d6dbe0506e3ae6"
        },
        "date": 1781484260077,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 449,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 740,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6218,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10583,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2617,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3390,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2488,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16267,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8518,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 873,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 739,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1590,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1525,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 756,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19540,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2302,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10872,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103434,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 523277,
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
          "id": "790b59b694efb9a6378956a9f0f7cedaba280c55",
          "message": "refactor(session): remove dead worker grant surface",
          "timestamp": "2026-06-15T09:56:00+09:00",
          "tree_id": "460cdc7fe5714f412ce9ad77693d842a248aa7cf",
          "url": "https://github.com/INONONO66/openomni/commit/790b59b694efb9a6378956a9f0f7cedaba280c55"
        },
        "date": 1781485023490,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 647,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5889,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9674,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2510,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2915,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2444,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15521,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8066,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 834,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 723,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1421,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1608,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 734,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21166,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2280,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11056,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102940,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 537085,
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
          "id": "e053bf76ee352e7de6d766521985cdb1ec5cf428",
          "message": "refactor(session): remove dead actor registry surface",
          "timestamp": "2026-06-15T10:07:02+09:00",
          "tree_id": "a6bbbe16f8290dbe627cf3b924fa45278a48cd52",
          "url": "https://github.com/INONONO66/openomni/commit/e053bf76ee352e7de6d766521985cdb1ec5cf428"
        },
        "date": 1781485676956,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 717,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6175,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10434,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2626,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3318,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2538,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16639,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8515,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 880,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 744,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1575,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1547,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 751,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19801,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2276,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10803,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102722,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 521267,
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
          "id": "10d45b5afd5e1ef8683912c35909e342ed71bfea",
          "message": "refactor(session): split session namespace responsibilities",
          "timestamp": "2026-06-15T10:26:15+09:00",
          "tree_id": "fed45b66f4695ebb286c03ae4281813f24eeb673",
          "url": "https://github.com/INONONO66/openomni/commit/10d45b5afd5e1ef8683912c35909e342ed71bfea"
        },
        "date": 1781486829815,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 444,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 605,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5847,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9334,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2497,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2775,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2377,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15055,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7867,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 813,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 680,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1323,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1598,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 722,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20611,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2335,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11156,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102807,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 520904,
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
          "id": "fafbddd42b2e9c4512ce29a593b9c8a927f095c2",
          "message": "refactor(session): split work item store responsibilities",
          "timestamp": "2026-06-15T10:42:44+09:00",
          "tree_id": "06787b6bf9ccb673f8a5b34c5eea875b476c42a9",
          "url": "https://github.com/INONONO66/openomni/commit/fafbddd42b2e9c4512ce29a593b9c8a927f095c2"
        },
        "date": 1781487822915,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 653,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6179,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9441,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2599,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2917,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2402,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15853,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8295,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 829,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 714,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1430,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1530,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 777,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19156,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2266,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10746,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102198,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 515849,
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
          "id": "9174552822a92f345d42bbc39264c023003b8757",
          "message": "refactor(llm): split processor responsibilities",
          "timestamp": "2026-06-15T11:10:10+09:00",
          "tree_id": "7e040260f315476326d5f1fff1c094af0a039efb",
          "url": "https://github.com/INONONO66/openomni/commit/9174552822a92f345d42bbc39264c023003b8757"
        },
        "date": 1781489466151,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 605,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5865,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9581,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2505,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2842,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2353,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15235,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7944,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 806,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 702,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1313,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1601,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 725,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20854,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2289,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11072,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102234,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 535299,
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
          "id": "f5188c614db56b30436a8cc77de2a00c9420e9a1",
          "message": "refactor(coordinator): split worker supervisor responsibilities",
          "timestamp": "2026-06-15T11:31:51+09:00",
          "tree_id": "76f5c20ef6e084c79f0d3752fc5f12fa91f2cb16",
          "url": "https://github.com/INONONO66/openomni/commit/f5188c614db56b30436a8cc77de2a00c9420e9a1"
        },
        "date": 1781490772590,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 444,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 605,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5951,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9828,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2502,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2821,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2347,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15074,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7894,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 802,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 697,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1304,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1615,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 746,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20403,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2256,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10816,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102880,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 538284,
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
          "id": "c7bac2a5f653651300b77168d292d13d76b428f4",
          "message": "refactor(server): split worker runner responsibilities",
          "timestamp": "2026-06-15T11:53:51+09:00",
          "tree_id": "7a73f42099c3211ebaa7908f8e212a5140c816a8",
          "url": "https://github.com/INONONO66/openomni/commit/c7bac2a5f653651300b77168d292d13d76b428f4"
        },
        "date": 1781492087613,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 673,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6196,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9912,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2609,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2913,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2515,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16083,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8399,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 844,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 724,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1511,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1512,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 778,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19458,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2261,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10799,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102744,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 531039,
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
          "id": "169396e1ea9da770fcbe6ea615bb4202486a8f7e",
          "message": "refactor(coordinator): split worker manager responsibilities",
          "timestamp": "2026-06-15T12:12:17+09:00",
          "tree_id": "c8d0765a77d0e869d9d4c0fb49e09d3657066675",
          "url": "https://github.com/INONONO66/openomni/commit/169396e1ea9da770fcbe6ea615bb4202486a8f7e"
        },
        "date": 1781493198678,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 443,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 603,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5872,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9532,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2498,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2812,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2373,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15064,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7906,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 797,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 699,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1336,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1582,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 719,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20424,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2267,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10773,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101910,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 512070,
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
          "id": "146813e20f082b60be78a40ef6d55ab1653aa0f0",
          "message": "refactor(openomni): split ingress authority responsibilities (#421)",
          "timestamp": "2026-06-15T12:34:14+09:00",
          "tree_id": "f8962a699b28c518bcc9b69900a9b2488680f4ed",
          "url": "https://github.com/INONONO66/openomni/commit/146813e20f082b60be78a40ef6d55ab1653aa0f0"
        },
        "date": 1781494511678,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 351,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 578,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 4835,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 8567,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2042,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2640,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 1845,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 12605,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 6795,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 693,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 581,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1316,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 39,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1207,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 614,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 15660,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1778,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8527,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 79654,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 408966,
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
          "id": "ad9af3798bc8092d14f5264868968f64a0838a5a",
          "message": "refactor(agent): split policy engine responsibilities (#422)",
          "timestamp": "2026-06-15T12:54:23+09:00",
          "tree_id": "489690f883ae8f83959c8e1d40f3256855124b6a",
          "url": "https://github.com/INONONO66/openomni/commit/ad9af3798bc8092d14f5264868968f64a0838a5a"
        },
        "date": 1781495720662,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 350,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 508,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 4854,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 7753,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2024,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2350,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 1777,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 12242,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 6517,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 652,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 557,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1180,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 39,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1201,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 620,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 15287,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 1759,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 8522,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 79536,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 401179,
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
          "id": "54be47d24dc57f829de0f7f5c2fe2f7d85681028",
          "message": "refactor(openomni): split tool executor responsibilities\n\nSplit ToolExecutor internals into focused helper modules while preserving public behavior and side-effect guard coverage.",
          "timestamp": "2026-06-15T13:23:42+09:00",
          "tree_id": "377e6dba1d334586bef47ceb50d7d95ba87be4dc",
          "url": "https://github.com/INONONO66/openomni/commit/54be47d24dc57f829de0f7f5c2fe2f7d85681028"
        },
        "date": 1781497481180,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 467,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 657,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6175,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9842,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2601,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3010,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2451,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16078,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8302,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 810,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 701,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1397,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1530,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 771,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19629,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2261,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10969,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101714,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 536715,
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
          "id": "9469138bdc201a86184244d6ca83bc2373ea3f8d",
          "message": "refactor(openomni): split ingress handlers\n\nSplit IngressHandlers internals into focused helper modules while preserving the public namespace API and direct ingress behavior.",
          "timestamp": "2026-06-15T13:39:23+09:00",
          "tree_id": "9678c7007df6926382b7dfbaa22e727d0d84cbf5",
          "url": "https://github.com/INONONO66/openomni/commit/9469138bdc201a86184244d6ca83bc2373ea3f8d"
        },
        "date": 1781498422144,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 524,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 677,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6199,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9774,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2664,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2964,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2588,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16279,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8447,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 837,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 745,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1419,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 53,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1599,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 759,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19585,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2131,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11387,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 107557,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 541541,
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
          "id": "7e8fd7998b31c34908c36e66f79dc3d721429c34",
          "message": "refactor(openomni): split background manager responsibilities\n\nSplit BackgroundManager internals while preserving the public API and behavior.",
          "timestamp": "2026-06-15T13:56:58+09:00",
          "tree_id": "2a8e0335f086855d8ec33ab6b01df4f8adb977f3",
          "url": "https://github.com/INONONO66/openomni/commit/7e8fd7998b31c34908c36e66f79dc3d721429c34"
        },
        "date": 1781499471710,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 652,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6174,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9477,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2603,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3002,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2431,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15886,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8247,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 830,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 712,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1395,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1518,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 758,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19072,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2255,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10788,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102071,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 519312,
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
          "id": "6023d5da857ddbcb3af310d2a01aa2ba2c85d230",
          "message": "refactor(server): split bootstrap resident wait bridge\n\nExtract the worker-to-Resident inbound wait bridge from server bootstrap while preserving coordinator startup behavior.",
          "timestamp": "2026-06-15T14:13:04+09:00",
          "tree_id": "b9cb40e916d78e634146031741c6e8b541997b4a",
          "url": "https://github.com/INONONO66/openomni/commit/6023d5da857ddbcb3af310d2a01aa2ba2c85d230"
        },
        "date": 1781500446531,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 552,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 720,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6373,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11638,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2747,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3327,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2622,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16559,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8680,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 916,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 808,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1591,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 53,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1616,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 752,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20299,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2150,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11574,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 109442,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 560830,
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
          "id": "dd2a05eb8629801fb1a9f2802e0ad174bdf7b60b",
          "message": "refactor(openomni): split background limit middleware (#427)",
          "timestamp": "2026-06-15T14:31:05+09:00",
          "tree_id": "657e7fff5a64fa347aea65780e9bcc3437511761",
          "url": "https://github.com/INONONO66/openomni/commit/dd2a05eb8629801fb1a9f2802e0ad174bdf7b60b"
        },
        "date": 1781501524572,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 638,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6217,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9455,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2599,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2891,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2428,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15886,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8733,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 804,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 705,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1380,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 49,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1539,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 765,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19149,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2263,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10982,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101674,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 540551,
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
          "id": "3c3212c40976fb3f64d2af5c7d25267d5f7d082f",
          "message": "refactor(openomni): split subagent spawn policy (#428)",
          "timestamp": "2026-06-15T14:43:01+09:00",
          "tree_id": "d12dd87edd2c7e56b509f1685fbf65f43832adbf",
          "url": "https://github.com/INONONO66/openomni/commit/3c3212c40976fb3f64d2af5c7d25267d5f7d082f"
        },
        "date": 1781502243859,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 445,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 587,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5831,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9007,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2486,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2685,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2347,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 14881,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7854,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 785,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 689,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1307,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1604,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 749,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20564,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2280,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10987,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101870,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 537085,
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
          "id": "3bfec1450cc6d2a8770e1d89b82cf7a25d3c7925",
          "message": "refactor(session): split bus query responsibilities (#429)",
          "timestamp": "2026-06-15T15:10:51+09:00",
          "tree_id": "9a3c999f5d04d7915b9b71b963acc404b300dcc7",
          "url": "https://github.com/INONONO66/openomni/commit/3bfec1450cc6d2a8770e1d89b82cf7a25d3c7925"
        },
        "date": 1781503908569,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 485,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 1216,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6072,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 15206,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2638,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 5159,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 3330,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16600,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 9041,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 1381,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 1163,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 2155,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 48,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1879,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 958,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 25725,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2937,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 12438,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 109742,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 550528,
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
          "id": "f19d35f49bf89277df8c3deb8f6d233b9b2a2529",
          "message": "refactor(session): split bus persistence observer (#430)\n\n* refactor(session): split bus persistence observer\n\n* fix(session): harden bus persistence edge cases",
          "timestamp": "2026-06-15T15:56:37+09:00",
          "tree_id": "d0db1cd6fe9711a3bf102898d59749c2dffc5024",
          "url": "https://github.com/INONONO66/openomni/commit/f19d35f49bf89277df8c3deb8f6d233b9b2a2529"
        },
        "date": 1781506651377,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 449,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 691,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6229,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10523,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2616,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3130,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2488,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16115,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8412,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 876,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 751,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1547,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1546,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 790,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19396,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2267,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10878,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102808,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 547503,
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
          "id": "b2d58d78efef49e8c32690a2ce9dfccd24778af9",
          "message": "refactor(protocol): split work item contracts",
          "timestamp": "2026-06-15T16:27:46+09:00",
          "tree_id": "1bfb773adf3ba74c0251b6b378dc1c628725d6cf",
          "url": "https://github.com/INONONO66/openomni/commit/b2d58d78efef49e8c32690a2ce9dfccd24778af9"
        },
        "date": 1781508523370,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 652,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6193,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9688,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2605,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3018,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2411,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15955,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8322,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 834,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 715,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1449,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1530,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 771,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19337,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2262,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10941,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102604,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 541043,
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
          "id": "f48cc1f0b01c5138f1b7c2cada2982e1714f9174",
          "message": "refactor(openomni): split resident runtime responsibilities",
          "timestamp": "2026-06-15T16:48:37+09:00",
          "tree_id": "5f2d7e42b6e714d8c1d93be8cb9e59853a471474",
          "url": "https://github.com/INONONO66/openomni/commit/f48cc1f0b01c5138f1b7c2cada2982e1714f9174"
        },
        "date": 1781509777246,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 455,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 701,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6180,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10453,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2609,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3231,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2488,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16067,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8325,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 877,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 723,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1533,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1536,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 799,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19483,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2253,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10863,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103299,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 529247,
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
          "id": "73c2b365ab953db15f3e41f66700ffb585693e6a",
          "message": "refactor(openomni): split workspace lock responsibilities\n\nSplit WorkspaceLock internals into focused helpers and add regression coverage for unsafe marker and stale external lock behavior.",
          "timestamp": "2026-06-15T22:16:44+09:00",
          "tree_id": "766bb473bbd0af9f985170442e7819272811fca6",
          "url": "https://github.com/INONONO66/openomni/commit/73c2b365ab953db15f3e41f66700ffb585693e6a"
        },
        "date": 1781529467875,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 643,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6223,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9693,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2611,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2854,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2453,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15829,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8238,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 814,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 703,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1422,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1524,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 784,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19327,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2239,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10783,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102067,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 524374,
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
          "id": "427c028772bf5af1572da701a4b4cd18ea49ca29",
          "message": "refactor(agent): split mcp client responsibilities\n\nSplit McpClient helper responsibilities into focused runtime modules while preserving the public client export surface. Remove dead duration assignments and cover the unknown runtime transport fallback with a regression test.",
          "timestamp": "2026-06-15T22:38:20+09:00",
          "tree_id": "56105dca824b08b9aa4b6efcb181b148d197377c",
          "url": "https://github.com/INONONO66/openomni/commit/427c028772bf5af1572da701a4b4cd18ea49ca29"
        },
        "date": 1781530759198,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 551,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 698,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6259,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11021,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2683,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3162,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2594,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16268,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8536,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 880,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 780,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1493,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 52,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1604,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 737,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20447,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2109,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11411,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 108113,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 549115,
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
          "id": "281dfab5ba16d8e51da522fcfbe0fde6c3c8fa83",
          "message": "refactor(protocol): split app connector contracts (#435)",
          "timestamp": "2026-06-15T22:51:13+09:00",
          "tree_id": "fdf9af1e680f9081fcca57faca13910f346aafd9",
          "url": "https://github.com/INONONO66/openomni/commit/281dfab5ba16d8e51da522fcfbe0fde6c3c8fa83"
        },
        "date": 1781531531176,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 446,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 666,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5883,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10517,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2501,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3120,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2440,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15625,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8110,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 863,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 735,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1461,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1589,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 733,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20942,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2335,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11252,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104162,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 544371,
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
          "id": "abcfa5c6ac7cfb595719d7fd0b9db649f36df981",
          "message": "refactor(protocol): split communication contracts (#436)",
          "timestamp": "2026-06-15T23:01:36+09:00",
          "tree_id": "4f4fa2f0b33ed16a24cad58ba0dd813fcd44d2e0",
          "url": "https://github.com/INONONO66/openomni/commit/abcfa5c6ac7cfb595719d7fd0b9db649f36df981"
        },
        "date": 1781532156384,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 454,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 720,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6193,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 11025,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2647,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3359,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2602,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16435,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8605,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 1016,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 770,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1672,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1581,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 802,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20499,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2273,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10923,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 104284,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 533304,
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
          "id": "b4d9c5549000fd26915f550847a1a035a2a64afc",
          "message": "refactor(server): split mcp provider responsibilities (#437)",
          "timestamp": "2026-06-15T23:13:44+09:00",
          "tree_id": "bb15eb86f6e77285d33e63e82f25f6e5eb966131",
          "url": "https://github.com/INONONO66/openomni/commit/b4d9c5549000fd26915f550847a1a035a2a64afc"
        },
        "date": 1781532894249,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 456,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 718,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6277,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10643,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2642,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3232,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2522,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16381,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8479,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 863,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 733,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1581,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1521,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 773,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19906,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2276,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11035,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103374,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 540764,
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
          "id": "11bde5728c064431270af2c8f59176bdaf16a320",
          "message": "refactor(openomni): split runtime binding responsibilities (#438)",
          "timestamp": "2026-06-15T23:31:08+09:00",
          "tree_id": "f81a72357cbede1346dc2aba4e8bdb7fe271cec4",
          "url": "https://github.com/INONONO66/openomni/commit/11bde5728c064431270af2c8f59176bdaf16a320"
        },
        "date": 1781533933210,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 442,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 587,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5839,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9177,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2502,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2679,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2347,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15101,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7895,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 805,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 693,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1312,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1590,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 743,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20069,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2295,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10858,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101540,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 536995,
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
          "id": "b6b306928f9f2c5eea896915f1e6e18151d71885",
          "message": "refactor(coordinator): centralize ipc socket data access (#439)",
          "timestamp": "2026-06-15T23:45:49+09:00",
          "tree_id": "f3501df425f561acc8272e67ac70595a46ab1818",
          "url": "https://github.com/INONONO66/openomni/commit/b6b306928f9f2c5eea896915f1e6e18151d71885"
        },
        "date": 1781534813545,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 444,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 608,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5877,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9274,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2497,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2757,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2396,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15183,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7910,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 815,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 697,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1322,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1589,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 702,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20642,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2295,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 11079,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 103167,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 542149,
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
          "id": "c2e99d29e3d79c129cee4b2cc3bbf66deba8b164",
          "message": "refactor(openomni): type injection queue policy context (#440)",
          "timestamp": "2026-06-15T23:58:04+09:00",
          "tree_id": "f6b13ebf68bed88bcf74da7c2c3925fc67c4ae99",
          "url": "https://github.com/INONONO66/openomni/commit/c2e99d29e3d79c129cee4b2cc3bbf66deba8b164"
        },
        "date": 1781535545699,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 674,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5871,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10369,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2528,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3160,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2469,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15612,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8095,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 836,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 724,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1428,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1604,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 733,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 21319,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2316,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10957,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102893,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 521822,
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
          "id": "c57c700de6cc823fa31966281975cbbab84e4a07",
          "message": "refactor(llm): align runtime with ai sdk (#441)",
          "timestamp": "2026-06-18T00:16:39+09:00",
          "tree_id": "d51dd7ace2a436d78eec168779060f9a0ae60945",
          "url": "https://github.com/INONONO66/openomni/commit/c57c700de6cc823fa31966281975cbbab84e4a07"
        },
        "date": 1781709470875,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 449,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 635,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5865,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9623,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2513,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2934,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2410,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15217,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8040,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 819,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 704,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1413,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1584,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 708,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20464,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2270,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10920,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102872,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 516440,
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
          "id": "75a063a1d04ed65036b80980eaf682cf6da7d921",
          "message": "refactor(server): require mcp audit session context (#442)",
          "timestamp": "2026-06-18T15:14:53+09:00",
          "tree_id": "88c98681d9fc943bab3d988aff9bd85e82a1ad21",
          "url": "https://github.com/INONONO66/openomni/commit/75a063a1d04ed65036b80980eaf682cf6da7d921"
        },
        "date": 1781763347822,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 450,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 678,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 6206,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 10144,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2600,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3024,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2508,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 16915,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8675,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 857,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 736,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1436,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 50,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1548,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 773,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19424,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2235,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10800,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102030,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 517859,
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
          "id": "c41f5c2090bcbd4c9bd2223851ea23dba84dec47",
          "message": "refactor(llm): remove unused agent schema (#443)",
          "timestamp": "2026-06-18T15:20:08+09:00",
          "tree_id": "e30222cb00f203d16fef284b9a7ac1b2b6e91cbc",
          "url": "https://github.com/INONONO66/openomni/commit/c41f5c2090bcbd4c9bd2223851ea23dba84dec47"
        },
        "date": 1781763668664,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 447,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 597,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5882,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9148,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2508,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 2778,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2385,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15018,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 7941,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 793,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 691,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1287,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1576,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 724,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 19925,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2233,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10806,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 101914,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 513752,
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
          "id": "8a5ec2f749d59f4655f834fd9ccd62447d91a198",
          "message": "refactor(openomni): reuse work item readback envelope (#444)",
          "timestamp": "2026-06-18T15:25:07+09:00",
          "tree_id": "85cff1701b94557de7a732d4e5fcb9fe34add7a0",
          "url": "https://github.com/INONONO66/openomni/commit/8a5ec2f749d59f4655f834fd9ccd62447d91a198"
        },
        "date": 1781763969900,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "background-queue/10-tasks/find-splice",
            "value": 448,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/10-tasks/map-cycle",
            "value": 652,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/find-splice",
            "value": 5906,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/100-tasks/map-cycle",
            "value": 9952,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/find-splice",
            "value": 2506,
            "unit": "ns/op"
          },
          {
            "name": "background-queue/50-tasks/map-cycle",
            "value": 3024,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/10-subscribers",
            "value": 2422,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/100-subscribers",
            "value": 15600,
            "unit": "ns/op"
          },
          {
            "name": "bus-fanout/50-subscribers",
            "value": 8086,
            "unit": "ns/op"
          },
          {
            "name": "compaction/100-messages",
            "value": 826,
            "unit": "ns/op"
          },
          {
            "name": "compaction/20-messages",
            "value": 714,
            "unit": "ns/op"
          },
          {
            "name": "compaction/500-messages",
            "value": 1401,
            "unit": "ns/op"
          },
          {
            "name": "compaction/should-compact",
            "value": 47,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/parse-message",
            "value": 1596,
            "unit": "ns/op"
          },
          {
            "name": "message-serialization/stringify-message",
            "value": 729,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-messages",
            "value": 20570,
            "unit": "ns/op"
          },
          {
            "name": "session-hydration/get-session",
            "value": 2273,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/10-sessions",
            "value": 10827,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/100-sessions",
            "value": 102273,
            "unit": "ns/op"
          },
          {
            "name": "storage-session-list/500-sessions",
            "value": 518204,
            "unit": "ns/op"
          }
        ]
      }
    ]
  }
}