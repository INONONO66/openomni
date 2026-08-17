// A worker that crashes immediately on spawn (#audit M2): the supervisor's
// crash-loop breaker must trip after MAX_CONSECUTIVE_FAST_CRASHES instead of
// respawning it forever.
process.exit(1);
