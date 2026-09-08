// gsScheduleOcrTableExtractor.js
// Extracts GS schedule records from SCANNED/image-based PDFs — documents
// with no embedded text layer, where extractGsScheduleTable() (the
// PDF-text-layer version) can't find anything to work with at all.
//
// Uses Tesseract OCR's word-level bounding boxes as the position source,
// then hands them to the EXACT SAME column-detection and record-boundary
// logic (gsTableParsingCore.js) already proven correct on real GS-02/17
// documents — this isn't a separate, less-tested implementation, it's the
// same hard-won parsing approach applied to a different position source.
//
// Coordinate note: OCR bounding boxes use image/pixel space where Y
// increases DOWNWARD (top of page = smallest Y). The shared core assumes
// PDF's convention (Y increases UPWARD). Y is inverted here so both
// extractors share identical geometry logic.
require('./boilerplateStripper')
const { renderPdfToImages, ocrImage } = require('../extraction/ocrTesseract');
const { parseGsTableFromItems } = require('./gsTableParsingCore');
const { stripBoilerplate } = require('./boilerplateStripper');

// OCR renders at a higher pixel scale than PDF's native point space, so
// the "same line" / "header band" tolerances need to be scaled up
// proportionally — a 3-point tolerance that works for PDF text would be
// far too tight for OCR pixel coordinates at 2x-3x render scale.
const OCR_RENDER_SCALE = 2.5;
const OCR_ROW_Y_TOLERANCE = 8;
const OCR_HEADER_BAND_HEIGHT = 40;

/**
 * Extracts structured GS schedule records from a scanned PDF buffer via OCR.
 * Same return shape as extractGsScheduleTable() for drop-in compatibility.
 */
async function extractGsScheduleTableViaOcr(buffer) {
  const images = await renderPdfToImages(buffer, OCR_RENDER_SCALE);

  const allItems = []; // { x, y, str, page } — Y inverted to increase upward, matching the shared core's convention
  let scheduleNumber = null;

  for (let pageIndex = 0; pageIndex < images.length; pageIndex++) {
    const { words } = await ocrImage(images[pageIndex]);
    for (const word of words) {
      const str = word.text.trim();
      if (!str) continue;
      allItems.push({
        x: word.x0,
        y: -word.y0, // invert: OCR's downward-increasing Y -> upward-increasing, matching PDF convention
        str,
        page: pageIndex + 1
      });

      if (!scheduleNumber) {
        const m = str.match(/GS-\d+/i);
        // OCR rarely gets a multi-word phrase as one "word" — the schedule
        // number check here is best-effort; a full-text pass over all
        // page words for "GENERAL SCHEDULE NO. GS-XX" as a joined string
        // fallback below is more reliable if this misses.
        if (m) scheduleNumber = m[0].toUpperCase();
      }
    }
  }

  // Fallback schedule-number detection: join all words on page 1 and
  // search as a single string, since OCR word-splitting can separate
  // "GS-02" from "GENERAL SCHEDULE NO." across different word boxes.
  if (!scheduleNumber) {
    const page1Text = allItems.filter((i) => i.page === 1).map((i) => i.str).join(' ');
    const m = page1Text.match(/GENERAL SCHEDULE NO\.?\s*(GS-\d+)/i);
    if (m) scheduleNumber = m[1].toUpperCase();
  }

  const result = parseGsTableFromItems(allItems, {
    rowYTolerance: OCR_ROW_Y_TOLERANCE,
    headerBandHeight: OCR_HEADER_BAND_HEIGHT,
    maxHeaderLabelLength: 40
  });

  if (result.error) {
    return { scheduleNumber, records: [], debugColumns: null, error: result.error };
  }

  const records = result.records.map((r) => ({
    scheduleNumber: scheduleNumber || '',
    ...r,
    textToEmbed: `${r.seriesName} : ${stripBoilerplate(r.description)}`
  }));

  return { scheduleNumber, records, debugColumns: result.debugColumns, error: null };
}

module.exports = { extractGsScheduleTableViaOcr };