// textChunker.js
// Splits long text into overlapping chunks that fit within the embedding
// model's real token limit (all-MiniLM-L6-v2: 256 tokens), instead of
// silently hard-truncating and losing everything past that point.
//
// UPGRADED: sentence-boundary-aware chunking instead of blind word-count
// slicing. The previous version could cut a sentence in half at an
// arbitrary word boundary — even with overlap, that still means BOTH
// halves of the cut sentence get embedded incomplete in at least one
// chunk. Packing whole sentences into each chunk (never splitting one)
// keeps every chunk's content semantically coherent.
//
// Chunking is word-based for SIZE limits, not exact-tokenizer-based —
// English averages roughly 1.3 tokens per word (subword splitting), so a
// conservative word count per chunk keeps comfortably under the model's
// real token ceiling without needing to load the model's tokenizer
// separately just to count.

const WORDS_PER_CHUNK = 150; // ~195 tokens at 1.3 tokens/word — safely under the 256 limit
const OVERLAP_SENTENCES = 1; // carry the last sentence of a chunk into the next, for context continuity

/**
 * Splits text into sentences. Not a perfect NLP sentence splitter (doesn't
 * handle every abbreviation edge case), but good enough for chunking
 * purposes — an occasional over-split on "Mr." or similar just produces
 * one slightly-short sentence, not a correctness problem for embeddings.
 */
function splitIntoSentences(text) {
  const raw = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
  return raw.map((s) => s.trim()).filter(Boolean);
}

function wordCount(str) {
  return str.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Splits text into overlapping chunks, never cutting a sentence in half.
 * Sentences are packed greedily into a chunk until adding the next one
 * would exceed wordsPerChunk; a new chunk then starts, carrying the last
 * OVERLAP_SENTENCES sentence(s) from the previous chunk for continuity.
 *
 * A single sentence longer than wordsPerChunk on its own (rare, but
 * possible with long legal/technical text) falls back to word-slicing
 * just for that one oversized sentence, so it still gets embedded rather
 * than being dropped or breaking the loop.
 */
function chunkText(text, wordsPerChunk = WORDS_PER_CHUNK, overlapSentences = OVERLAP_SENTENCES) {
  if (!text || !text.trim()) return [];

  const totalWords = wordCount(text);
  if (totalWords <= wordsPerChunk) {
    return [text.trim()];
  }

  const sentences = splitIntoSentences(text);
  const chunks = [];
  let currentSentences = [];
  let currentWordCount = 0;

  function flushChunk() {
    if (currentSentences.length > 0) {
      chunks.push(currentSentences.join(' ').trim());
    }
  }

  for (const sentence of sentences) {
    const sentenceWords = wordCount(sentence);

    // A single sentence too big to fit in one chunk on its own — fall back
    // to word-slicing just for this sentence, flushing whatever was
    // building before it.
    if (sentenceWords > wordsPerChunk) {
      flushChunk();
      const words = sentence.trim().split(/\s+/);
      for (let i = 0; i < words.length; i += wordsPerChunk) {
        chunks.push(words.slice(i, i + wordsPerChunk).join(' '));
      }
      currentSentences = [];
      currentWordCount = 0;
      continue;
    }

    if (currentWordCount + sentenceWords > wordsPerChunk) {
      flushChunk();
      // Carry the last sentence(s) forward into the new chunk for overlap
      const carryOver = currentSentences.slice(-overlapSentences);
      currentSentences = [...carryOver, sentence];
      currentWordCount = carryOver.reduce((sum, s) => sum + wordCount(s), 0) + sentenceWords;
    } else {
      currentSentences.push(sentence);
      currentWordCount += sentenceWords;
    }
  }
  flushChunk();

  return chunks;
}

module.exports = { chunkText, splitIntoSentences, WORDS_PER_CHUNK, OVERLAP_SENTENCES };