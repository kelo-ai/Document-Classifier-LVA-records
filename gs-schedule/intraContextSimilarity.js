// intraContextSimilarity.js
// "Intra-Context Similarity": how similar are the top-K retrieved
// candidates to EACH OTHER — a different question than Retrieval
// Confidence (which asks "is the top match good relative to the query").
//
// Needs zero ground truth — computed directly from the candidates'
// embeddings, already available at search time.
//
// Why this matters, separately from Retrieval Confidence:
//   - HIGH intra-context similarity: the 3 candidates cluster tightly
//     together. Could mean the schedule has near-duplicate/overlapping
//     series descriptions (worth a human checking for redundant records),
//     OR it could just mean the query landed in a genuinely tight topic
//     cluster (e.g. "Arrest Files: Adult" vs "Arrest Files: Juvenile" vs
//     "Arrest Files: Adult - Pre-1974" are legitimately close in meaning).
//   - LOW intra-context similarity: the 3 candidates are quite different
//     from each other — the search is reaching across distinct topics to
//     fill out 3 results, which can itself be a sign the query doesn't
//     have many good matches in the collection at all.

/**
 * Cosine similarity between two equal-length vectors.
 * Assumes both are already unit-normalized (true for embeddings coming
 * out of embeddingGenerator.js) — if not, the dot product alone isn't
 * quite cosine similarity, so this normalizes defensively anyway.
 */
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Computes the average pairwise cosine similarity among a set of
 * candidate embeddings — the Intra-Context Similarity score.
 * embeddingsBySeriesNumber: { seriesNumber: [vector], ... }
 * Returns null if fewer than 2 embeddings are available (nothing to compare).
 */
function computeIntraContextSimilarity(embeddingsBySeriesNumber) {
  const ids = Object.keys(embeddingsBySeriesNumber);
  if (ids.length < 2) {
    return { score: null, pairwise: [], interpretation: 'Not enough candidates to compare (need at least 2).' };
  }

  const pairwise = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const sim = cosineSimilarity(embeddingsBySeriesNumber[ids[i]], embeddingsBySeriesNumber[ids[j]]);
      pairwise.push({ pair: [ids[i], ids[j]], similarity: sim });
    }
  }

  const avg = pairwise.reduce((sum, p) => sum + p.similarity, 0) / pairwise.length;

  let interpretation;
  if (avg >= 0.75) {
    interpretation = 'Candidates are very similar to each other — possibly overlapping/redundant series, or a tight topic cluster.';
  } else if (avg >= 0.45) {
    interpretation = 'Candidates are moderately related — a plausible topic neighborhood.';
  } else {
    interpretation = 'Candidates are quite different from each other — the search may be reaching across unrelated topics to fill results.';
  }

  return { score: avg, pairwise, interpretation };
}

module.exports = { cosineSimilarity, computeIntraContextSimilarity };
