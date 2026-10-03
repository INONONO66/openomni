# hook plugin (scaffold)

This directory is the `plugins/hook` dependency band declared in `script/check-deps.ts` (`AGENT_PLUGINS`). #1256 lands the plugin and its exports. It holds no source until then: an unconsumed export would be dead code under the literal-zero rule and uncovered under the patch-coverage gate, and a test-only consumer would be pretend coverage.
