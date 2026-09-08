// perfLogger.js
// Centralized timing utility — wraps any async step, logs its duration
// consistently, and accumulates a per-request timing breakdown so you can
// see exactly where time went across the whole pipeline (extraction,
// cleaning, chunking, embedding, Milvus search, LLM call) instead of
// scattered ad-hoc console.log(durationMs) calls in different formats.

const { performance } = require('perf_hooks');

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
    return s;
  }

  return { step, record, summary, logSummary };
}

module.exports = { startTimingSession };
