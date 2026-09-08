// ragTriad.js
// The "RAG Triad" — a standard 3-metric evaluation framework for RAG
// pipelines (retrieval + generation), replacing the single confidence
// score for the CLASSIFICATION flow specifically (which has an actual
// LLM-generated answer to evaluate — plain /search-gs retrieval doesn't,
// so it keeps using retrievalConfidence.js instead).
//
// The three metrics answer three DIFFERENT questions that a single score
// can't distinguish between:
//
//   1. Context Relevance — were the retrieved candidates actually
//      relevant to the document? (a retrieval-quality question)
//   2. Groundedness — does the LLM's reasoning actually derive from the
//      chosen candidate's real content, or did it hallucinate a
//      justification not supported by what it was given? (a
//      faithfulness question — is the LLM making things up?)
//   3. Answer Relevance — does the final CHOSEN answer specifically fit
//      the document, independent of how the LLM got there? (an
//      outcome-quality question)
//
// Design choice: Groundedness and Answer Relevance are computed via
// embedding similarity (cheap, local, no extra API call) rather than a
// second LLM-judge call — a common lower-cost variant of the RAG Triad
// when an extra LLM round-trip per classification isn't worth the added
// latency/cost for this use case. This is a real trade-off, not free:
// an LLM-judge would likely catch subtler hallucinations that embedding
// similarity can miss (e.g. reasoning that uses the right VOCABULARY but
// draws an unsupported conclusion) — flagged here rather than left silent.

const { generateEmbedding } = require('../embeddings/embeddingGenerator');
const { cosineSimilarity } = require('./intraContextSimilarity');

const HIGH_THRESHOLD = 0.55;
const LOW_THRESHOLD = 0.40;

function tierFromScore(score) {
  if (score >= HIGH_THRESHOLD) return 'high';
  if (score >= LOW_THRESHOLD) return 'medium';
  return 'low';
}

/**
 * Context Relevance: were the retrieved candidates actually relevant?
 * Uses the same score+margin logic as retrievalConfidence.js, reframed
 * under RAG Triad terminology for the classification response.
 */
function computeContextRelevance(candidates) {
  if (!candidates || candidates.length === 0) {
    return { tier: 'none', score: null, explanation: 'No candidates were retrieved.' };
  }
  const topScore = candidates[0].score;
  const secondScore = candidates.length > 1 ? candidates[1].score : null;
  const margin = secondScore !== null ? topScore - secondScore : null;

  const tier = tierFromScore(topScore);
  const explanation = margin !== null
    ? `Top candidate scored ${topScore.toFixed(3)}, ${margin.toFixed(3)} ahead of the runner-up.`
    : `Top candidate scored ${topScore.toFixed(3)} (only one candidate available).`;

  return { tier, score: topScore, margin, explanation };
}

/**
 * Answer Relevance: does the CHOSEN candidate specifically fit the
 * document, independent of how the LLM reasoned about it? Uses that
 * candidate's own retrieval score directly — if the LLM picked a
 * candidate that scored poorly against the document in the first place,
 * the final answer's relevance is inherently limited regardless of how
 * well-written the reasoning sounds.
 */
function computeAnswerRelevance(candidates, chosenSeriesNumber) {
  const chosen = candidates.find((c) => c.seriesNumber === chosenSeriesNumber);
  if (!chosen) {
    return { tier: 'low', score: null, explanation: 'Chosen series was not among the retrieved candidates (unexpected).' };
  }
  const tier = tierFromScore(chosen.score);
  return {
    tier,
    score: chosen.score,
    explanation: `The chosen answer's own similarity to the document was ${chosen.score.toFixed(3)}.`
  };
}

/**
 * Groundedness: does the LLM's reasoning text actually derive from the
 * chosen candidate's real description, or does it read as generic/
 * unsupported? Measured via embedding similarity between the reasoning
 * and the candidate's actual description — high similarity suggests the
 * reasoning is genuinely anchored in real content, not hallucinated.
 */
async function computeGroundedness(reasoningText, chosenCandidateDescription) {
  if (!reasoningText || !chosenCandidateDescription) {
    return { tier: 'low', score: null, explanation: 'Missing reasoning or candidate description to compare.' };
  }

  const [reasoningEmb, descriptionEmb] = await Promise.all([
    generateEmbedding(reasoningText),
    generateEmbedding(chosenCandidateDescription)
  ]);

  if (!reasoningEmb.vector || !descriptionEmb.vector) {
    return { tier: 'low', score: null, explanation: 'Could not embed reasoning/description for comparison.' };
  }

  const similarity = cosineSimilarity(reasoningEmb.vector, descriptionEmb.vector);
  // Groundedness similarity naturally runs a bit lower than retrieval
  // similarity — reasoning is a different register of text (explaining
  // WHY) than a formal description (stating WHAT). Thresholds are
  // slightly relaxed relative to the retrieval-facing metrics above.
  const tier = similarity >= 0.45 ? 'high' : similarity >= 0.30 ? 'medium' : 'low';

  return {
    tier,
    score: similarity,
    explanation: `Reasoning text's similarity to the chosen series' actual description was ${similarity.toFixed(3)}.`
  };
}

/**
 * Runs all three RAG Triad metrics together for a classification result.
 */
async function computeRagTriad({ candidates, chosenSeriesNumber, reasoningText, chosenDescription }) {
  const contextRelevance = computeContextRelevance(candidates);
  const answerRelevance = computeAnswerRelevance(candidates, chosenSeriesNumber);
  const groundedness = await computeGroundedness(reasoningText, chosenDescription);

  return { contextRelevance, answerRelevance, groundedness };
}

module.exports = { computeRagTriad, computeContextRelevance, computeAnswerRelevance, computeGroundedness };
