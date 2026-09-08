// gsScheduleTableExtractor.js
// Extracts GS schedule records directly from a PDF's raw text positions —
// column detection and record-boundary logic now lives in
// gsTableParsingCore.js, shared with the OCR-based extractor
// (gsScheduleOcrTableExtractor.js) for scanned schedules. This file's job
// is just: get positioned text items out of a real PDF text layer, then
// hand them to the shared parser.
require('./boilerplateStripper')
const { parseGsTableFromItems } = require('./gsTableParsingCore');
const { stripBoilerplate } = require('./boilerplateStripper');

/**
 * Extracts structured GS schedule records directly from a PDF buffer.
 * Returns { scheduleNumber, records, debugColumns } — debugColumns is
 * included so the raw per-column text can be inspected if something looks
 * wrong, without needing another round of guessing.
 */
async function extractGsScheduleTable(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({ data, disableWorker: true }).promise;

  const allItems = []; // { x, y, str, page } — PDF space, Y increases upward
  let scheduleNumber = null;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items) {
      const str = item.str.trim();
      if (!str) continue;
      allItems.push({ x: item.transform[4], y: item.transform[5], str, page: p });

      if (!scheduleNumber) {
        const m = str.match(/GENERAL SCHEDULE NO\.\s*(GS-\d+)/i);
        if (m) scheduleNumber = m[1];
      }
    }
  }

  const result = parseGsTableFromItems(allItems, { rowYTolerance: 3, headerBandHeight: 15, maxHeaderLabelLength: 40 });

  if (result.error) {
    return { scheduleNumber, records: [], debugColumns: null, error: result.error };
  }

  const records = result.records.map((r) => ({
    scheduleNumber: scheduleNumber || '',
    ...r,
    // Boilerplate stripped ONLY for the embedding text — the full,
    // original description is still stored and displayed as-is; only
    // what gets vectorized is cleaned of shared administrative phrasing.
    textToEmbed: `${r.seriesName} : ${stripBoilerplate(r.description)}`
  }));

  return { scheduleNumber, records, debugColumns: result.debugColumns, error: null };
}

module.exports = { extractGsScheduleTable };