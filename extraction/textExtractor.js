// textExtractor.js
// Extracts plain text from in-memory file buffers.
// Supported: .pdf (pdfjs-dist), .docx/.doc (mammoth / word-extractor), .xls/.xlsx (xlsx)

const mammoth = require('mammoth');
const XLSX = require('xlsx');
const WordExtractor = require('word-extractor');
const { performance } = require('perf_hooks');
const { cleanExtractedText } = require('./textCleaner');

/**
 * Extract text from a PDF buffer using pdfjs-dist.
 * pdfjs-dist ships as ESM only, so it's loaded via dynamic import
 * even though this module itself is CommonJS.
 */
async function extractFromPdf(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data, disableWorker: true });
  const doc = await loadingTask.promise;

  // A visual "row" in a table PDF can span multiple columns that sit at the
  // same Y-coordinate but are far apart horizontally (e.g. a description
  // column's last line and a separate series-number column's cell). Joining
  // items purely by Y would merge those into one unreadable line and hide
  // structured data (like a standalone series number) inside a sentence.
  // A large horizontal gap between consecutive items is treated as a column
  // boundary and becomes a line break too, not just a Y change.
  const LINE_Y_TOLERANCE = 2;
  const COLUMN_GAP_THRESHOLD = 25;

  let fullText = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    // Sort into reading order: top-to-bottom (Y descending in PDF space),
    // then left-to-right (X ascending) within each line — this doesn't
    // assume pdfjs's raw item order already matches visual layout, which
    // isn't guaranteed for PDFs generated from table-based documents.
    const items = content.items
      .map((item) => ({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width || 0 }))
      .filter((item) => item.str.trim().length > 0);

    items.sort((a, b) => {
      if (Math.abs(a.y - b.y) > LINE_Y_TOLERANCE) return b.y - a.y;
      return a.x - b.x;
    });

    let lastY = null;
    let lastRight = null;
    for (const item of items) {
      const newLine = lastY !== null && Math.abs(item.y - lastY) > LINE_Y_TOLERANCE;
      const columnBreak = !newLine && lastRight !== null && (item.x - lastRight) > COLUMN_GAP_THRESHOLD;

      if (newLine || columnBreak) {
        fullText += '\n';
      } else if (fullText && !fullText.endsWith('\n') && !fullText.endsWith(' ')) {
        fullText += ' ';
      }
      fullText += item.str;
      lastY = item.y;
      lastRight = item.x + item.width;
    }
    fullText += '\n'; // page boundary
  }
  return fullText.trim();
}

/**
 * Strip HTML tags from a fragment, converting <p> to newlines.
 */
function stripTags(fragment) {
  return fragment.replace(/<p>/g, '').replace(/<\/p>/g, '\n').replace(/<[^>]+>/g, '').trim();
}

/**
 * Convert a single HTML <table>...</table> inner content into a markdown-style
 * pipe grid, preserving rows and columns in their true positions.
 */
function tableToMarkdown(tableInner) {
  const rows = [...tableInner.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const grid = rows.map((row) =>
    [...row.matchAll(/<t[dh]>([\s\S]*?)<\/t[dh]>/g)].map((c) => stripTags(c[1]))
  );
  let md = '\n--- Table ---\n';
  grid.forEach((row) => {
    md += '| ' + row.join(' | ') + ' |\n';
  });
  return md;
}

/**
 * Walks mammoth's HTML output in document order, converting tables to
 * markdown grids and everything else to plain text, preserving true
 * row/column structure for tables instead of flattening them.
 */
function htmlToStructuredText(html) {
  const parts = [];
  const tableRegex = /<table>([\s\S]*?)<\/table>/g;
  let lastEnd = 0;
  let match;
  while ((match = tableRegex.exec(html)) !== null) {
    const before = html.slice(lastEnd, match.index);
    if (before.trim()) parts.push(stripTags(before));
    parts.push(tableToMarkdown(match[1]));
    lastEnd = tableRegex.lastIndex;
  }
  const after = html.slice(lastEnd);
  if (after.trim()) parts.push(stripTags(after));
  return parts.join('\n\n');
}

/**
 * Extract text from a .docx buffer using mammoth.
 * quality='high' preserves table structure (rows/columns as markdown grids).
 * quality='low' returns flat raw text only (tables collapse into plain text).
 */
async function extractFromDocx(buffer, quality) {
  if (quality === 'high') {
    const result = await mammoth.convertToHtml({ buffer });
    return htmlToStructuredText(result.value).trim();
  }
  const result = await mammoth.extractRawText({ buffer });
  return result.value.trim();
}

/**
 * Extract text from a legacy .doc buffer using word-extractor.
 */
async function extractFromDoc(buffer) {
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buffer);
  return doc.getBody().trim();
}

/**
 * Extract text from .xls/.xlsx buffers using SheetJS (xlsx).
 * All sheets are concatenated as CSV for a plain-text representation.
 */
function extractFromSpreadsheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  let text = '';
  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    text += `--- Sheet: ${sheetName} ---\n`;
    text += XLSX.utils.sheet_to_csv(sheet) + '\n';
  });
  return text.trim();
}

/**
 * Wraps a promise with a timeout so a corrupted/malformed file can't hang
 * the extraction pipeline indefinitely (some malformed PDFs cause parsers
 * to spin rather than throw).
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Classifies common failure signatures into a clearer, user-facing reason,
 * so "corrupted file" cases are distinguishable from other bugs.
 */
function classifyExtractionError(err) {
  const msg = (err && err.message) || String(err);
  if (/invalid pdf|bad xref|corrupt|malformed|unexpected end/i.test(msg)) {
    return { corrupted: true, message: 'The file appears to be corrupted or is not a valid document of its type.' };
  }
  if (/password|encrypted/i.test(msg)) {
    return { corrupted: false, message: 'The file is password-protected and cannot be read.' };
  }
  if (/timed out/i.test(msg)) {
    return { corrupted: true, message: 'Extraction took too long and was stopped — the file may be corrupted or unusually complex.' };
  }
  return { corrupted: false, message: 'Text extraction failed: ' + msg };
}

const EXTRACTION_TIMEOUT_MS = 30000;

/**
 * Main entry point: routes to the correct extractor based on file extension.
 * quality: 'high' or 'low' — affects table structure preservation where applicable.
 * Returns { text, error, corrupted, durationMs } — error is null on success.
 * Extraction failures are non-fatal to the upload itself; caller decides how to handle them.
 */
async function extractText(buffer, extension, quality = 'low') {
  const startTime = performance.now();
  const ext = extension.toLowerCase();

  try {
    let rawText;
    const extractionPromise = (async () => {
      switch (ext) {
        case '.pdf':
          return extractFromPdf(buffer);
        case '.docx':
          return extractFromDocx(buffer, quality);
        case '.doc':
          return extractFromDoc(buffer);
        case '.xls':
        case '.xlsx':
          return extractFromSpreadsheet(buffer);
        default:
          throw new Error(`Unsupported extension for extraction: ${ext}`);
      }
    })();

    rawText = await withTimeout(extractionPromise, EXTRACTION_TIMEOUT_MS, `Extraction of ${ext} file`);

    const cleanedText = cleanExtractedText(rawText);
    const durationMs = Math.round(performance.now() - startTime);

    return { text: cleanedText, rawText: rawText, error: null, corrupted: false, durationMs };
  } catch (err) {
    const { corrupted, message } = classifyExtractionError(err);
    const durationMs = Math.round(performance.now() - startTime);
    console.error(`[extractText] ${ext} extraction failed after ${durationMs}ms:`, err.message);
    return { text: null, rawText: null, error: message, corrupted, durationMs };
  }
}

module.exports = { extractText };
