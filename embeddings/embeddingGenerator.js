// embeddingGenerator.js
// Generates vector embeddings from extracted document text, entirely locally,
// using transformers.js (open-source, runs the model in-process via ONNX —
// no API key, no cloud account, no per-request cost).
//
// Model: all-MiniLM-L6-v2 — a small, widely-used open-source sentence
// embedding model (384 dimensions), good balance of speed and quality for
// semantic search over documents.
//
// NOTE: On first use, this downloads the model (~90MB) from Hugging Face's
// public model hub and caches it locally under ./.cache — needs internet
// access once, fully offline afterward.

const { performance } = require('perf_hooks');
const { chunkText } = require('../extraction/textChunker');

let extractorPromise = null;

/**
 * Lazily loads the embedding pipeline once and reuses it across calls —
 * same pattern as the persistent Tesseract worker, since model loading
 * is the expensive part.
 */
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    })();
  }
  return extractorPromise;
}

/**
 * Embeds a single chunk of text — assumes the caller has already ensured
 * it's short enough to fit the model's real token limit.
 */
async function embedSingleChunk(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Averages multiple embedding vectors into one, then re-normalizes the
 * result — the standard way to combine chunk-level embeddings into a
 * single vector representing the whole (longer) original text.
 */
function averageVectors(vectors) {
  const dim = vectors[0].length;
  const summed = new Array(dim).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) summed[i] += vec[i];
  }
  const averaged = summed.map((v) => v / vectors.length);

  // Re-normalize to unit length (averaging unit vectors doesn't
  // guarantee the result is still unit length).
  const magnitude = Math.sqrt(averaged.reduce((sum, v) => sum + v * v, 0));
  return magnitude > 0 ? averaged.map((v) => v / magnitude) : averaged;
}

/**
 * Generate an embedding for a piece of text, using chunking + overlap
 * instead of hard truncation when the text exceeds the model's real
 * token limit. Short text (the common case — most GS descriptions) goes
 * through as a single chunk with no extra cost. Long text gets split into
 * overlapping chunks (see textChunker.js), each embedded separately, then
 * averaged into one final vector — this preserves context from the whole
 * text instead of silently discarding everything past ~256 tokens.
 */
async function generateEmbedding(text) {
  const startTime = performance.now();
  try {
    if (!text || !text.trim()) {
      return { vector: null, error: 'No text provided to embed.', durationMs: 0 };
    }

    const chunks = chunkText(text);
    if (chunks.length === 0) {
      return { vector: null, error: 'No text provided to embed.', durationMs: 0 };
    }

    const chunkVectors = [];
    for (const chunk of chunks) {
      chunkVectors.push(await embedSingleChunk(chunk));
    }

    const vector = chunkVectors.length === 1 ? chunkVectors[0] : averageVectors(chunkVectors);

    const durationMs = Math.round(performance.now() - startTime);
    return { vector, error: null, durationMs, chunkCount: chunks.length };
  } catch (err) {
    const durationMs = Math.round(performance.now() - startTime);
    return { vector: null, error: 'Embedding generation failed: ' + err.message, durationMs };
  }
}

module.exports = { generateEmbedding };
