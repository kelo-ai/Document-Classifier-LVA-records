// perfLogger.js
// Centralized timing utility — wraps any async step, logs its duration
// consistently, and accumulates a per-request timing breakdown so you can
// see exactly where time went across the whole pipeline (extraction,
// cleaning, chunking, embedding, Milvus search, LLM call) instead of
// scattered ad-hoc console.log(durationMs) calls in different formats.

const { performance } = require('perf_hooks');

// Shared in-memory log — every completed timing session gets pushed here,
// so the dashboard can show a live history of recent operations, not just
// what's visible in the server's own console. Capped so it doesn't grow
// unbounded over a long-running server; only the most recent entries
// matter for a live timing view.
const MAX_LOG_ENTRIES = 100;
const recentLogs = [];

function pushToLog(entry) {
  recentLogs.push(entry);
  if (recentLogs.length > MAX_LOG_ENTRIES) {
    recentLogs.shift(); // drop the oldest
  }
}

/**
 * Returns recent timing log entries, most recent first.
 */
function getRecentLogs(limit = MAX_LOG_ENTRIES) {
  return recentLogs.slice(-limit).reverse();
}

/**
 * Creates a new timing session for one request (one upload, one search,
 * one classification). Call .step() around each stage, then .summary()
 * at the end to get the full breakdown.
 */
function startTimingSession(label) {
  const start = performance.now();
  const steps = [];

  /**
   * Wraps an async function, timing it and recording the result.
   * Usage: const result = await session.step('extraction', () => extractText(...));
   */
  async function step(stepName, fn) {
    const stepStart = performance.now();
    try {
      const result = await fn();
      const durationMs = Math.round(performance.now() - stepStart);
      steps.push({ step: stepName, durationMs, success: true });
      return result;
    } catch (err) {
      const durationMs = Math.round(performance.now() - stepStart);
      steps.push({ step: stepName, durationMs, success: false, error: err.message });
      throw err;
    }
  }

  /**
   * Records a duration that was already measured elsewhere (e.g. a
   * duration returned by a function that does its own internal timing),
   * without re-wrapping the call.
   */
  function record(stepName, durationMs, success = true) {
    steps.push({ step: stepName, durationMs, success });
  }

  function summary() {
    const totalMs = Math.round(performance.now() - start);
    return { label, totalMs, steps };
  }

  function logSummary() {
    const s = summary();
    const breakdown = s.steps.map((st) => `${st.step}=${st.durationMs}ms${st.success ? '' : ' (FAILED)'}`).join(', ');
    console.log(`[perf] ${s.label}: total=${s.totalMs}ms | ${breakdown}`);
    pushToLog({ ...s, timestamp: new Date().toISOString() });
    return s;
  }

  return { step, record, summary, logSummary };
}

module.exports = { startTimingSession, getRecentLogs };