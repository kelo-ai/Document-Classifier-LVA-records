// retrievalConfidence.js
// "Retrieval Confidence" (a.k.a. Context Relevance in RAG evaluation
// terminology): how much should we trust that the top search result is
// actually the right one, based purely on the vector search scores —
// no LLM involved, this runs on every /search-gs call for free.
//
// Strategy: a single absolute similarity score isn't reliable on its own
// (cosine similarity from sentence embedding models isn't well-calibrated —
// unrelated legal-boilerplate text can still score 0.3-0.4 from shared
// generic phrasing). So this combines TWO signals:
//   1. Absolute score of the top result — is it a decent match at all?
//   2. Margin between the top result and the runner-up — does the top
//      result clearly stand out, or is it basically tied with #2?
//
// A high absolute score with a small margin is genuinely ambiguous (two
// near-identical candidates), even though the raw score alone would look
// "confident". This function catches that case, not just a raw threshold.
//
// NOTE: these thresholds are reasonable starting defaults for MiniLM-based
// cosine similarity on short legal/administrative text — NOT yet
// calibrated against real query results from your actual data. Once
// /search-gs has been run against enough real queries, revisit these
// numbers against what genuinely-correct vs. genuinely-wrong matches
// actually scored, the same way the extraction logic was calibrated
// against real GS-02/GS-17 text earlier in this project.

const SCORE_FLOOR_LOW = 0.40;   // below this, treat the top match as unreliable regardless of margin
const SCORE_FLOOR_HIGH = 0.55;  // above this (with a clear margin), treat as a strong match
const MARGIN_THRESHOLD = 0.08;  // gap needed between #1 and #2 to call the top result "clearly ahead"

/**
 * Computes a retrieval confidence tier from a ranked results array
 * (each item must have a `similarityScore` field, already sorted
 * descending — which is what gsSearch.js's searchGsSchedule() returns).
 */
function computeRetrievalConfidence(results) {
  if (!results || results.length === 0) {
    return { tier: 'none', topScore: null, secondScore: null, margin: null, explanation: 'No results to evaluate.' };
  }

  const topScore = results[0].similarityScore;
  const secondScore = results.length > 1 ? results[1].similarityScore : null;
  const margin = secondScore !== null ? topScore - secondScore : null;

  let tier;
  let explanation;

  if (topScore < SCORE_FLOOR_LOW) {
    tier = 'low';
    explanation = `Top match score (${topScore.toFixed(3)}) is below the reliability floor — none of the candidates may genuinely fit.`;
  } else if (topScore >= SCORE_FLOOR_HIGH && (margin === null || margin >= MARGIN_THRESHOLD)) {
    tier = 'high';
    explanation = margin === null
      ? `Strong match score (${topScore.toFixed(3)}), only one candidate available.`
      : `Top match clearly stands out — score ${topScore.toFixed(3)}, ${margin.toFixed(3)} ahead of the runner-up.`;
  } else if (margin !== null && margin < MARGIN_THRESHOLD) {
    tier = 'medium';
    explanation = `Top candidates are close in score (margin ${margin.toFixed(3)}) — the top result may be ambiguous between similar series.`;
  } else {
    tier = 'medium';
    explanation = `Moderate match score (${topScore.toFixed(3)}) — plausible but not a strong fit.`;
  }

  return { tier, topScore, secondScore, margin, explanation };
}

module.exports = { computeRetrievalConfidence, SCORE_FLOOR_LOW, SCORE_FLOOR_HIGH, MARGIN_THRESHOLD };
