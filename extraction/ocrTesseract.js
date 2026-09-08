// ocrTesseract.js
// Open-source OCR for scanned/image-based PDFs, using Tesseract.js
// (pure JS/WASM port of the Tesseract OCR engine — no cloud account,
// no per-page cost, runs entirely on this machine).
//
// Pipeline: PDF page -> rendered to an image (pdfjs-dist + @napi-rs/canvas)
//           -> Tesseract.js OCR on that image -> cleaned text (+ optional
//              table reconstruction from word bounding boxes for 'high' quality).
//
// NOTE: Tesseract.js downloads its English language model (~10-15MB) from
// a public CDN the first time it runs, then caches it locally. This needs
// internet access once; after that it works fully offline.

const { createCanvas } = require('@napi-rs/canvas');
const Tesseract = require('tesseract.js');
const { performance } = require('perf_hooks');
const { cleanExtractedText } = require('./textCleaner');
const { preprocessCanvas } = require('./imagePreprocessor');

const OCR_TIMEOUT_MS = 60000; // per-page cap — corrupted/huge pages shouldn't hang forever
const MAX_PAGES = 20; // safety cap so a malicious/huge PDF can't exhaust resources

// ---------- Persistent Tesseract worker (performance optimization) ----------
// Creating a fresh worker per OCR call reloads the language model every
// time, which is the single biggest source of latency. Reusing one worker
// across requests cuts per-document OCR time significantly after the first
// call "warms up" the model.
let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng').catch((err) => {
      workerPromise = null; // allow retry on next call if init failed
      throw err;
    });
  }
  return workerPromise;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Render every page of a PDF buffer to PNG image buffers.
 * scale controls resolution: higher scale = better OCR accuracy, slower.
 * Throws a clear error if the PDF itself is corrupted/unreadable.
 */
async function renderPdfToImages(buffer, scale) {
  let pdfjsLib;
  try {
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (err) {
    throw new Error('Failed to load PDF rendering engine: ' + err.message);
  }

  const data = new Uint8Array(buffer);
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data, disableWorker: true }).promise;
  } catch (err) {
    throw new Error('Invalid or corrupted PDF: ' + err.message);
  }

  const pageCount = Math.min(doc.numPages, MAX_PAGES);
  const images = [];

  for (let i = 1; i <= pageCount; i++) {
    try {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      // Preprocess before OCR: grayscale + contrast stretch always;
      // full pipeline (denoise + binarize via Otsu thresholding) at high quality,
      // since it's slower but meaningfully improves accuracy on noisy scans.
      preprocessCanvas(canvas, scale >= 3.0 ? 'high' : 'low');

      images.push(canvas.toBuffer('image/png'));
    } catch (pageErr) {
      // A single bad page shouldn't kill the whole document's OCR —
      // log it and continue with whatever pages did render.
      console.error(`[ocrTesseract] Failed to render page ${i}:`, pageErr.message);
    }
  }

  if (images.length === 0) {
    throw new Error('No pages could be rendered from this PDF — it may be corrupted.');
  }
  return images;
}

/**
 * Extracts word-level bounding boxes from Tesseract's result, regardless
 * of which shape this Tesseract.js version returns them in — older
 * versions expose a flat data.words array, newer versions nest word data
 * under data.blocks[].paragraphs[].lines[].words[] instead. Checking only
 * the flat shape silently returned zero words on a version that uses the
 * nested shape (confirmed directly: real OCR text extraction succeeded
 * perfectly, but data.words came back empty).
 */
function extractWordsFromTesseractData(data) {
  if (Array.isArray(data.words) && data.words.length > 0) {
    return data.words;
  }

  const words = [];
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          words.push(word);
        }
      }
    }
  }
  return words;
}

/**
 * Run Tesseract OCR on a single image buffer using the shared persistent worker.
 * Returns both plain text and word-level bounding boxes (used for
 * table reconstruction in high-quality mode).
 */
async function ocrImage(imageBuffer) {
  const worker = await getWorker();
  // Tesseract.js 5.1+ disables every output format except plain text by
  // default (a performance change) — block/word-level data (needed here
  // for table-column reconstruction) must be explicitly requested via the
  // 3rd argument, or data.blocks comes back null even though data.text
  // works perfectly. Confirmed directly: without this, OCR text
  // recognition succeeded completely but word coordinates were silently
  // never generated at all, not just misplaced in the result shape.
  const { data } = await withTimeout(
    worker.recognize(imageBuffer, {}, { text: true, blocks: true }),
    OCR_TIMEOUT_MS,
    'OCR recognition'
  );
  const rawWords = extractWordsFromTesseractData(data);
  return {
    text: data.text,
    words: rawWords.map((w) => ({
      text: w.text,
      x0: w.bbox.x0,
      y0: w.bbox.y0,
      x1: w.bbox.x1,
      y1: w.bbox.y1
    }))
  };
}

/**
 * Heuristic table reconstruction from OCR word bounding boxes:
 * groups words into lines by y-position, then splits each line into
 * columns wherever the horizontal gap between words is unusually large.
 * This is an approximation (no true layout model like commercial OCR
 * services provide) but preserves row/column structure reasonably well
 * for simple grid-style tables.
 */
function wordsToTableGrid(words) {
  if (!words.length) return [];

  const lineTolerance = 10;
  const lines = [];
  words
    .slice()
    .sort((a, b) => a.y0 - b.y0)
    .forEach((w) => {
      const yCenter = (w.y0 + w.y1) / 2;
      let line = lines.find((l) => Math.abs(l.yCenter - yCenter) < lineTolerance);
      if (!line) {
        line = { yCenter, words: [] };
        lines.push(line);
      }
      line.words.push(w);
    });

  const gapThreshold = 25;
  return lines.map((line) => {
    const sorted = line.words.slice().sort((a, b) => a.x0 - b.x0);
    const cells = [];
    let current = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].x0 - sorted[i - 1].x1;
      if (gap > gapThreshold) {
        cells.push(current.map((w) => w.text).join(' '));
        current = [sorted[i]];
      } else {
        current.push(sorted[i]);
      }
    }
    if (current.length) cells.push(current.map((w) => w.text).join(' '));
    return cells;
  });
}

function gridToMarkdown(grid) {
  let md = '\n--- Table (OCR reconstructed) ---\n';
  grid.forEach((row) => {
    md += '| ' + row.join(' | ') + ' |\n';
  });
  return md;
}

/**
 * Classifies common failure signatures for clearer error messages.
 */
function classifyOcrError(err) {
  const msg = (err && err.message) || String(err);
  if (/corrupted|invalid.*pdf|no pages could be rendered/i.test(msg)) {
    return { corrupted: true, message: 'The file appears to be corrupted or is not a valid PDF.' };
  }
  if (/timed out/i.test(msg)) {
    return { corrupted: true, message: 'OCR took too long and was stopped — the file may be corrupted or too complex.' };
  }
  return { corrupted: false, message: 'OCR failed: ' + msg };
}

/**
 * Main entry point.
 * quality='low'  -> lower render resolution, plain text only, faster.
 * quality='high' -> higher render resolution, plus heuristic table
 *                   reconstruction from word positions.
 * Returns { text, tableCount, error, corrupted, durationMs }.
 */
async function extractWithTesseract(buffer, quality) {
  const startTime = performance.now();
  try {
    const scale = quality === 'high' ? 3.0 : 1.5;
    const images = await renderPdfToImages(buffer, scale);

    let combinedText = '';
    let tableCount = 0;

    for (const image of images) {
      const { text, words } = await ocrImage(image);

      // Plain OCR text is always kept — this preserves the natural
      // line-by-line structure that downstream document-specific parsers
      // (e.g. GS schedule detection) rely on, regardless of quality mode.
      combinedText += text + '\n';

      if (quality === 'high') {
        const grid = wordsToTableGrid(words);
        const looksTabular = grid.filter((row) => row.length > 1).length >= 2;
        if (looksTabular) {
          // Table reconstruction is appended as a supplement, not a
          // replacement — so both the plain text AND the structured
          // table view are available in the same result.
          combinedText += gridToMarkdown(grid) + '\n';
          tableCount++;
        }
      }
    }

    const cleanedText = cleanExtractedText(combinedText);
    const durationMs = Math.round(performance.now() - startTime);
    console.log(`[ocrTesseract] OCR completed in ${durationMs}ms (quality=${quality}, pages=${images.length})`);

    return { text: cleanedText, rawText: combinedText.trim(), tableCount, error: null, corrupted: false, durationMs };
  } catch (err) {
    const { corrupted, message } = classifyOcrError(err);
    const durationMs = Math.round(performance.now() - startTime);
    console.error(`[ocrTesseract] OCR failed after ${durationMs}ms:`, err.message);
    return { text: null, rawText: null, tableCount: 0, error: message, corrupted, durationMs };
  }
}

/**
 * Gracefully shuts down the persistent worker — call on server shutdown
 * to release resources cleanly.
 */
async function terminateWorker() {
  if (workerPromise) {
    try {
      const worker = await workerPromise;
      await worker.terminate();
    } catch (err) {
      console.error('[ocrTesseract] Error terminating worker:', err.message);
    }
    workerPromise = null;
  }
}

module.exports = { extractWithTesseract, terminateWorker, renderPdfToImages, ocrImage, getWorker, withTimeout, OCR_TIMEOUT_MS };