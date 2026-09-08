// gsSearch.js
// Pure retrieval layer (the "R" in RAG, no "G"): given a query or document
// text, embed it and return the top 3 most similar GS record series, each
// with its full readable metadata and a similarity score.
//
// No LLM involved here — this just answers "what are the 3 closest
// matches?", nothing picks a single final answer or generates text.

const { generateEmbedding } = require('../embeddings/embeddingGenerator');
const { searchSimilarSeries, getEmbeddingsByIds } = require('../milvus/gsScheduleCollection');
const { getMetadataBatch } = require('./gsScheduleMetadataStore');
const { computeRetrievalConfidence } = require('./retrievalConfidence');
const { computeIntraContextSimilarity } = require('./intraContextSimilarity');
const { extractSalientText } = require('./classificationTextCleaner');

/**
 * Returns the top K most similar GS record series to the given text,
 * plus retrievalConfidence (is the top match good relative to the query)
 * and intraContextSimilarity (are the candidates similar to EACH OTHER).
 */
async function searchGsSchedule(queryText, topK = 3) {
  // Strips metadata-style noise before embedding — matters most when a
  // full document (not just a short search phrase) gets pasted in here.
  const salientText = extractSalientText(queryText);
  const embeddingResult = await generateEmbedding(salientText);
  if (!embeddingResult.vector) {
    return { success: false, error: 'Could not embed query text: ' + embeddingResult.error, results: [] };
  }

  const matches = await searchSimilarSeries(embeddingResult.vector, topK);
  if (matches.length === 0) {
    return {
      success: true,
      results: [],
      retrievalConfidence: computeRetrievalConfidence([]),
      intraContextSimilarity: { score: null, pairwise: [], interpretation: 'No candidates to compare.' }
    };
  }

  const results = getMetadataBatch(matches.map((m) => m.seriesNumber))
    .map((meta, i) => ({ ...meta, similarityScore: matches[i].score }));

  const retrievalConfidence = computeRetrievalConfidence(results);

  const candidateEmbeddings = await getEmbeddingsByIds(matches.map((m) => m.seriesNumber));
  const intraContextSimilarity = computeIntraContextSimilarity(candidateEmbeddings);

  return { success: true, results, retrievalConfidence, intraContextSimilarity };
}

module.exports = { searchGsSchedule };