// gsScheduleParser.js
// Detects whether an uploaded document IS a GS-series records retention
// schedule (Library of Virginia format), and if so, parses its table rows
// into structured records directly from the document's own extracted text.
//
// IMPORTANT LIMITATION: real PDF text extraction does NOT preserve a fixed
// field order (name -> description -> number -> retention -> disposition).
// Retention period can appear before OR after the disposition method line
// depending on the page's cell layout. This parser anchors record
// boundaries on the description's opening phrase ("This series documents"),
// which is consistent across every record in this document family,
// rather than guessing boundaries from field order.
//
// KNOWN EDGE CASE: when two adjacent records are both short enough that
// their series number/retention/disposition lines interleave BEFORE the
// second record's description begins (observed in GS-02's "Audit Records:
// External/Internal" pair, where External has no separate retention line),
// the two records merge into one rather than splitting incorrectly. This
// is flagged in the merged record's description for visibility rather than
// silently corrupting unrelated records.

const KNOWN_DISPOSITION_METHODS = [
  'Non-confidential Destruction',
  'Confidential Destruction',
  'Permanent, In Agency'
];

const FOOTER_NOISE_PATTERNS = [
  /^\d+\s+of\s+\d+$/i,
  /^COUNTY AND MUNICIPAL GOVERNMENTS$/i,
  /^Government Records Services$/i,
  /^LIBRARY OF VIRGINIA$/i,
  /^RECORDS RETENTION AND DISPOSITION SCHEDULE$/i,
  /^GENERAL SCHEDULE NO\./i,
  /^Fiscal Records$/i,
  /^EFFECTIVE SCHEDULE DATE/i,
  /^RECORD SERIES AND DESCRIPTION$/i,
  /^SERIES NUMBER SCHEDULED RETENTION PERIOD DISPOSITION METHOD$/i,
  /^\(?\d{3}\)?\s*\d{3}-\d{4}$/, // phone numbers
  /^\d+ E\. Broad St/i
];

const DESCRIPTION_START_PATTERN = /^This series documents/i;

function isGsScheduleDocument(text) {
  if (!text) return false;
  return /GENERAL SCHEDULE NO\.\s*GS-\d+/i.test(text) &&
         /RECORDS?\s+SERIES AND DESCRIPTION/i.test(text);
}

function extractScheduleNumber(text) {
  const match = text.match(/GENERAL SCHEDULE NO\.\s*(GS-\d+)/i);
  return match ? match[1] : null;
}

function isFooterNoise(line) {
  return FOOTER_NOISE_PATTERNS.some((pattern) => pattern.test(line.trim()));
}

function isNumLine(line) {
  return /^\d{6}$/.test(line.trim());
}

function isDispLine(line) {
  return KNOWN_DISPOSITION_METHODS.includes(line.trim());
}

function isPlainOtherLine(line) {
  return !isNumLine(line) && !isDispLine(line) && !DESCRIPTION_START_PATTERN.test(line);
}

/**
 * Parses GS schedule records from extracted text.
 *
 * Step 1: find record boundaries — a "name" line is one immediately
 * followed by a line starting with "This series documents" (every
 * record's description opens with this exact phrase in this document
 * family). This is a far more reliable anchor than guessing from field
 * order, since retention/disposition line order varies per record.
 *
 * Step 2: within each name-to-next-name span, classify every remaining
 * line as a series number, disposition method, or free text (added to
 * description if no series number seen yet, otherwise to retention).
 */
function parseGsScheduleRecords(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !isFooterNoise(l));

  const boundaries = [];
  for (let i = 1; i < lines.length; i++) {
    if (DESCRIPTION_START_PATTERN.test(lines[i]) && isPlainOtherLine(lines[i - 1])) {
      boundaries.push(i - 1); // index of the NAME line
    }
  }

  if (boundaries.length === 0) return [];

  const records = [];
  for (let b = 0; b < boundaries.length; b++) {
    const startIdx = boundaries[b];
    const endIdx = (b + 1 < boundaries.length) ? boundaries[b + 1] : lines.length;
    const span = lines.slice(startIdx, endIdx);

    const seriesName = span[0];
    const descLines = [];
    const retentionLines = [];
    let seriesNumber = null;
    let dispositionMethod = null;
    let mergedNote = false;

    for (let i = 1; i < span.length; i++) {
      const line = span[i];
      if (isNumLine(line)) {
        if (!seriesNumber) {
          seriesNumber = line;
        } else {
          mergedNote = true; // a second series number landed in this span — flag it
          retentionLines.push(`[additional series ${line} merged here]`);
        }
      } else if (isDispLine(line)) {
        if (!dispositionMethod) {
          dispositionMethod = line;
        } else {
          retentionLines.push(line); // extra disposition text, preserve as raw text rather than drop it
        }
      } else if (!seriesNumber) {
        descLines.push(line);
      } else {
        retentionLines.push(line);
      }
    }

    records.push({
      seriesNumber: seriesNumber || '',
      seriesName: mergedNote ? `${seriesName} [NOTE: extraction merged an adjacent record here — verify manually]` : seriesName,
      description: descLines.join(' ').replace(/\s+/g, ' ').trim(),
      retentionPeriod: retentionLines.join(' ').replace(/\s+/g, ' ').trim() || dispositionMethod || '',
      dispositionMethod: dispositionMethod || ''
    });
  }

  return records;
}

module.exports = { isGsScheduleDocument, extractScheduleNumber, parseGsScheduleRecords };
