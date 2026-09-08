// gsClassifier.js
// The final pipeline stage: given a document's text, find the top 3
// candidate GS record series by vector similarity, ask an LLM (via Groq)
// to pick the best match and explain why, then map that choice back to
// its full ground-truth metadata.
//
// Uses Groq's free-tier API — fast inference, OpenAI-compatible endpoint,
// called via plain fetch (no extra SDK dependency needed).
//
// SETUP REQUIRED:
//   1. Get a free API key: https://console.groq.com/keys
//   2. Add to .env:  GROQ_API_KEY=your-key-here
//
// Design note: the LLM only ever CHOOSES among 3 pre-vetted, real options —
// it never invents a retention period or disposition method. Those always
// come from a direct lookup in gsScheduleMetadataStore.js. This avoids the
// hallucination risk that comes with letting an LLM generate compliance
// facts directly.

const { generateEmbedding } = require('../embeddings/embeddingGenerator');
const { searchSimilarSeries } = require('../milvus/gsScheduleCollection');
const { getMetadataBatch } = require('./gsScheduleMetadataStore');
const { extractSalientText } = require('./classificationTextCleaner');
const { computeRagTriad } = require('./ragTriad');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

/**
 * Calls Groq's chat completions API. Throws a clear error if the API key
 * is missing or the request fails, rather than a cryptic fetch error.
 */
async function callGroq(prompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys and add it to your .env file.');
  }

  let response;
  try {
    response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }, // asks Groq to guarantee valid JSON output
        temperature: 0.2
      })
    });
  } catch (err) {
    throw new Error(`Could not reach Groq API: ${err.message}`);
  }

  if (!response.ok) {
    const errBody = await response.text();
    if (response.status === 401) {
      throw new Error('Groq API key was rejected — check GROQ_API_KEY in your .env file.');
    }
    throw new Error(`Groq request failed (${response.status}): ${errBody}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Builds the structured prompt: instructions + the 3 candidates (with
 * their real descriptions) + the document text to classify.
 */
function buildClassificationPrompt(documentText, candidates) {
  const candidateBlock = candidates
    .map((c, i) => `${i + 1}. Series Number: ${c.seriesNumber}\n   Title: ${c.seriesName}\n   Description: ${c.description}`)
    .join('\n\n');

  return `You are classifying a document into the correct Library of Virginia records retention series.

Below are the 3 candidate series that are the closest semantic matches to this document, found via vector search. Choose the ONE that best fits the document's actual content. Do not invent a series number that isn't listed below.

CANDIDATES:
${candidateBlock}

DOCUMENT TEXT (excerpt):
${documentText.slice(0, 3000)}

Respond with ONLY a JSON object in this exact format, no other text:
{"seriesNumber": "the chosen series number from the list above", "reasoning": "one or two sentences explaining why this series fits best"}`;
}

/**
 * Parses the LLM's response into {seriesNumber, reasoning}.
 * Groq's response_format:json_object guarantees valid JSON syntax, but
 * this stays tolerant of markdown fences / stray text just in case.
 */
function parseClassificationResponse(rawText) {
  let cleaned = rawText.replace(/```json|```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];

  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed.seriesNumber) {
      return { seriesNumber: null, reasoning: null, error: 'Model response had no seriesNumber field.' };
    }
    return { seriesNumber: String(parsed.seriesNumber), reasoning: parsed.reasoning || '', error: null };
  } catch (err) {
    return { seriesNumber: null, reasoning: null, error: 'Could not parse model response as JSON: ' + err.message };
  }
}

/**
 * Full pipeline: document text -> top 3 candidates -> LLM choice -> full metadata.
 */
async function classifyDocument(documentText) {
  // Step 1: embed the document and find the top 3 closest series by vector search
  // Step 1: embed a NOISE-STRIPPED version of the document for retrieval —
  // metadata fields (Unit, Zone, Document ID, dates) dilute the averaged
  // embedding vector and can hide the document's real topic. The LLM still
  // sees the FULL original documentText below — only retrieval benefits
  // from this cleaning, since embedding has no way to ignore irrelevant
  // fields the way an LLM naturally can.
  const salientText = extractSalientText(documentText);
  const embeddingResult = await generateEmbedding(salientText);
  if (!embeddingResult.vector) {
    return { success: false, error: 'Could not embed document text: ' + embeddingResult.error };
  }

  const matches = await searchSimilarSeries(embeddingResult.vector, 3);
  if (matches.length === 0) {
    return { success: false, error: 'No candidate series found — has any GS schedule been uploaded yet?' };
  }

  // Step 2: pull full readable data for those 3 candidates
  const candidates = getMetadataBatch(matches.map((m) => m.seriesNumber))
    .map((meta, i) => ({ ...meta, score: matches[i].score }));

  // Step 3: build the prompt and call Groq
  const prompt = buildClassificationPrompt(documentText, candidates);
  let rawText;
  try {
    rawText = await callGroq(prompt);
  } catch (err) {
    return { success: false, error: err.message, candidates };
  }

  // Step 4: parse the model's choice
  const parsed = parseClassificationResponse(rawText);
  if (parsed.error) {
    return { success: false, error: parsed.error, rawResponse: rawText, candidates };
  }

  // Step 5: map the chosen series number back to its full ground-truth metadata
  const chosen = candidates.find((c) => c.seriesNumber === parsed.seriesNumber);
  if (!chosen) {
    return {
      success: false,
      error: `Model chose seriesNumber "${parsed.seriesNumber}", which wasn't one of the 3 candidates offered.`,
      candidates
    };
  }

  // Step 6: RAG Triad evaluation — replaces a single confidence score with
  // 3 separate signals (Context Relevance, Groundedness, Answer Relevance),
  // since a single "confident" label can't distinguish "the retrieval was
  // good" from "the LLM's reasoning is actually grounded in real content"
  // from "the final answer specifically fits" — these can diverge, as
  // shown directly in testing (see ragTriad.js).
  const ragTriad = await computeRagTriad({
    candidates,
    chosenSeriesNumber: chosen.seriesNumber,
    reasoningText: parsed.reasoning,
    chosenDescription: chosen.description
  });

  return {
    success: true,
    reasoning: parsed.reasoning,
    result: {
      seriesNumber: chosen.seriesNumber,
      scheduleNumber: chosen.scheduleNumber,
      seriesName: chosen.seriesName,
      retentionPeriod: chosen.retentionPeriod,
      dispositionMethod: chosen.dispositionMethod
    },
    ragTriad,
    candidatesConsidered: candidates.map((c) => ({ seriesNumber: c.seriesNumber, seriesName: c.seriesName, score: c.score }))
  };
}

module.exports = { classifyDocument, buildClassificationPrompt, parseClassificationResponse };