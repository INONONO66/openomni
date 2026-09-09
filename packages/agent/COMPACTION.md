# Compaction boundary

A `Message.WithParts` is the atomic history entry. Tool calls and their result states share that entry, so a cut cannot split a call/result pair. The LLM adapter projects unfinished tool parts as interrupted results. Without a summary anchor, a kept window must begin with a user message.

User messages never enter summarizer content. They are preserved verbatim within the configured character budget. A prior anchor's raw body is passed as merge state, not recursively summarized as content. Empty merge input carries the previous anchor forward without invoking the summarizer.

A warm candidate may replace a synchronous merge only while its prefix IDs, content fingerprint, kept boundary, and prior anchor identity match. Failed or stale candidates fall back to the normal cut. Elision postpones that cut only when its estimated reclaim covers the measured overage; the next provider measurement remains authoritative.
