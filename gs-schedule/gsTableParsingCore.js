// gsTableParsingCore.js
// The shared column-detection + record-boundary logic behind GS schedule
// table extraction — factored out so both the PDF-text-layer extractor
// AND the OCR-based extractor (for scanned schedules) use the exact same,
// already-verified parsing approach instead of two separate
// implementations that could drift out of sync or be fixed in only one
// place.
//
// Works on a generic list of positioned text items: { x, y, str, page }.
// Convention: Y INCREASES UPWARD (PDF's native coordinate space) — a
// caller sourcing from image/pixel coordinates (where Y increases
// downward, like OCR bounding boxes) must invert Y before calling this,
// so both callers share identical sorting/geometry logic.

const KNOWN_DISPOSITION_METHODS = [
  'Non-confidential Destruction',
  'Confidential Destruction',
  'Permanent, In Agency'
];

const HEADER_LABELS = {
  name: /DESCRIPTION/i,
  num: /SERIES NUMBER|^NUMBER$/i,
  ret: /RETENTION/i,
  disp: /DISPOSITION/i
};

/**
 * Groups items into lines by Y-coordinate (top-to-bottom, Y-increases-
 * upward convention), each line's items sorted left-to-right.
 */
function groupIntoLines(items, rowYTolerance) {
  const sorted = items.slice().sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > rowYTolerance) return b.y - a.y;
    return a.x - b.x;
  });

  const lines = [];
  let current = null;
  for (const item of sorted) {
    const sameLine = current !== null && current.page === item.page && Math.abs(item.y - current.y) <= rowYTolerance;
    if (!sameLine) {
      current = { y: item.y, page: item.page, text: item.str };
      lines.push(current);
    } else {
      current.text += (current.text.endsWith(' ') || item.str.startsWith(' ') ? '' : ' ') + item.str;
    }
  }
  return lines;
}

/**
 * Parses GS schedule records from a generic set of positioned text items.
 *
 * @param allItems  [{ x, y, str, page }] — Y increases upward
 * @param options.rowYTolerance     how close in Y counts as "same line" —
 *                                  scale this up for OCR pixel coordinates
 *                                  vs. PDF point coordinates
 * @param options.headerBandHeight  how tall a band below the header row's
 *                                  Y to exclude — also scale for OCR
 * @param options.maxHeaderLabelLength  guards against a title sentence
 *                                  containing header keywords, see below
 */
function parseGsTableFromItems(allItems, options = {}) {
  const rowYTolerance = options.rowYTolerance ?? 3;
  const headerBandHeight = options.headerBandHeight ?? 15;
  const maxHeaderLabelLength = options.maxHeaderLabelLength ?? 40;

  // Find header row items to determine each column's starting X-position.
  // GUARD: a full title line like "RECORDS RETENTION AND DISPOSITION
  // SCHEDULE" contains the same keywords as the real column headers —
  // real header labels are always short, so a length cap distinguishes
  // an actual header label from a sentence that happens to contain the
  // same word.
  const headerX = {};
  const headerYByPage = {};
  for (const item of allItems) {
    if (item.str.trim().length > maxHeaderLabelLength) continue;
    for (const [col, pattern] of Object.entries(HEADER_LABELS)) {
      if (pattern.test(item.str)) {
        if (!(col in headerX)) headerX[col] = item.x;
        headerYByPage[item.page] = Math.max(headerYByPage[item.page] ?? -Infinity, item.y);
      }
    }
  }

  if (!headerX.name || !headerX.num || !headerX.ret || !headerX.disp) {
    return { records: [], debugColumns: null, error: 'Could not locate all 4 column headers — table layout may differ from the expected format.' };
  }

  // ORDER-AGNOSTIC: sort columns by ACTUAL X-position rather than assuming
  // a fixed left-to-right order, so a document with a different column
  // arrangement (e.g. Series Number first) still parses correctly.
  const sortedCols = Object.entries(headerX).sort((a, b) => a[1] - b[1]);

  function classifyColumn(x) {
    for (let i = 0; i < sortedCols.length - 1; i++) {
      const boundary = (sortedCols[i][1] + sortedCols[i + 1][1]) / 2;
      if (x < boundary) return sortedCols[i][0];
    }
    return sortedCols[sortedCols.length - 1][0];
  }

  const columns = { name: [], num: [], ret: [], disp: [] };
  for (const item of allItems) {
    const pageHeaderY = headerYByPage[item.page];
    // Excludes the header row, any wrapped header continuation just below
    // it, AND everything ABOVE it on the page (title, letterhead, schedule
    // date line). The "above" exclusion matters specifically for OCR
    // input: Tesseract tokenizes at the individual-word level, so a long
    // title line like "RECORDS RETENTION AND DISPOSITION SCHEDULE" has
    // its later words land at X-positions far enough right to cross into
    // the Number/Retention/Disposition column zones — contaminating real
    // record data with title fragments. PDF text-layer input doesn't hit
    // this (pdfjs groups whole phrases under one X-coordinate), but
    // excluding "above the header" is harmless there too, since real
    // record content never appears above the header row anyway.
    const inHeaderZone = pageHeaderY !== undefined && item.y > pageHeaderY - headerBandHeight;
    if (inHeaderZone) continue;
    columns[classifyColumn(item.x)].push(item);
  }

  const nameLines = groupIntoLines(columns.name, rowYTolerance);
  const numLines = groupIntoLines(columns.num, rowYTolerance);
  const retLines = groupIntoLines(columns.ret, rowYTolerance);
  const dispLines = groupIntoLines(columns.disp, rowYTolerance);

  // Record boundaries: anchored on the SERIES NUMBER column's Y-positions,
  // not on title text. This matters because titles frequently span
  // multiple lines (e.g. "Automotive Records: Federal Motor Carrier Drug
  // and" / "Alcohol Tests - Negative") — the old approach (finding "This
  // series documents" and treating the single line before it as the
  // entire title) silently absorbed the FIRST line of a multi-line title
  // into the PREVIOUS record's description, which then misaligned every
  // downstream field (number, retention, disposition) for both records,
  // since all four columns were sliced using that same wrong Y-boundary.
  // Numbers are always single-line and unambiguous, so anchoring on them
  // is immune to title line-wrapping entirely. Only genuine 6-digit
  // numbers are used as anchors — a stray non-numeric fragment that
  // occasionally lands in the number column (rare OCR/layout noise) is
  // ignored rather than treated as a false record boundary.
  const numberAnchors = numLines.filter((l) => /\d{6}/.test(l.text));
  const boundaries = numberAnchors.map((l) => ({ page: l.page, y: l.y, numberText: l.text }));

  /**
   * Assigns each line to whichever boundary (record) most recently
   * appeared above it, in top-to-bottom reading order. This replaces an
   * earlier two-sided range check (line must be below THIS boundary AND
   * above the NEXT one) — that approach could theoretically let a line
   * fall into a gap between the two thresholds and get silently dropped
   * (observed: the second line of some two-line titles vanished this
   * way). A single forward pass has no such gap — every line is assigned
   * to exactly one record, the nearest one at or above it.
   */
  function assignToNearestBoundary(lines) {
    const sorted = lines.slice().sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      return b.y - a.y;
    });
    const buckets = boundaries.map(() => []);
    let boundaryIdx = -1;
    for (const line of sorted) {
      while (
        boundaryIdx + 1 < boundaries.length &&
        (boundaries[boundaryIdx + 1].page < line.page ||
          (boundaries[boundaryIdx + 1].page === line.page && boundaries[boundaryIdx + 1].y >= line.y - rowYTolerance))
      ) {
        boundaryIdx++;
      }
      if (boundaryIdx === -1) continue; // line appears before the first known record (e.g. stray leftover text) — skip
      if (boundaries[boundaryIdx].page !== line.page) continue; // no boundary reached yet on this page
      buckets[boundaryIdx].push(line);
    }
    return buckets;
  }

  const nameBuckets = assignToNearestBoundary(nameLines);
  const retBuckets = assignToNearestBoundary(retLines);
  const dispBuckets = assignToNearestBoundary(dispLines);

  const records = [];
  for (let b = 0; b < boundaries.length; b++) {
    const { numberText } = boundaries[b];

    // Within this correctly-bounded record, title lines are everything in
    // the name column BEFORE the first line that starts the description
    // ("This series documents/consists of/includes...") — this text
    // pattern is now only used to split title from description WITHIN an
    // already-correct boundary, not to find the boundary itself.
    const nameGroup = nameBuckets[b];
    const descriptionStartIdx = nameGroup.findIndex((l) => /^This series\b/i.test(l.text));
    const titleLines = descriptionStartIdx === -1 ? nameGroup.slice(0, 1) : nameGroup.slice(0, descriptionStartIdx);
    const descriptionLines = descriptionStartIdx === -1 ? nameGroup.slice(1) : nameGroup.slice(descriptionStartIdx);

    const seriesName = titleLines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
    const description = descriptionLines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();

    const seriesNumberMatch = numberText.match(/\d{6}/);
    const retGroup = retBuckets[b].map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
    const dispGroup = dispBuckets[b].map((l) => l.text).join(' ').trim();

    const dispositionMatch = KNOWN_DISPOSITION_METHODS.find((d) => dispGroup.includes(d)) ||
                              KNOWN_DISPOSITION_METHODS.find((d) => retGroup.includes(d));

    records.push({
      seriesNumber: seriesNumberMatch ? seriesNumberMatch[0] : '',
      seriesName,
      description,
      retentionPeriod: retGroup || dispositionMatch || '',
      dispositionMethod: dispositionMatch || ''
    });
  }

  return {
    records,
    debugColumns: {
      name: nameLines.map((l) => l.text),
      num: numLines.map((l) => l.text),
      ret: retLines.map((l) => l.text),
      disp: dispLines.map((l) => l.text)
    },
    error: null
  };
}

module.exports = { parseGsTableFromItems, KNOWN_DISPOSITION_METHODS, HEADER_LABELS };