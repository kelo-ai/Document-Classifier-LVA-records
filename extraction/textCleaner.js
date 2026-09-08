// textCleaner.js
// Post-processes raw extracted text to remove noise, redundant whitespace,
// and common OCR/extraction formatting artifacts — without breaking
// intentional structure like markdown table rows ("| a | b |").
//
// No external library needed here — this is a well-defined, deterministic
// text-normalization task where hand-written regex rules are more reliable
// and auditable than pulling in a generic NLP dependency for it.

/**
 * Normalize Unicode to a consistent form (NFKC) — collapses visually
 * identical characters that come from different encodings (common when
 * text is extracted from PDFs using non-standard font encodings) into one
 * canonical representation, so downstream matching/search isn't fooled by
 * look-alike characters.
 */
function normalizeUnicode(text) {
  return text.normalize('NFKC');
}

/**
 * Rejoin words that were split across a line break with a trailing hyphen
 * (e.g. "docu-\nment" -> "document"). Common artifact from justified-text
 * PDFs and some OCR output. Only joins when both halves look like lowercase
 * word fragments, to avoid merging genuine hyphenated compounds or list markers.
 */
function dehyphenate(text) {
  return text.replace(/([a-z]{2,})-\n([a-z]{2,})/g, '$1$2');
}

/**
 * Normalize "smart" typographic quotes/dashes (common in Word/OCR output)
 * to plain ASCII equivalents, for consistent downstream text processing.
 */
function normalizeTypography(text) {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...');
}

/**
 * Remove stray single-character "words" surrounded by whitespace on their
 * own — a common OCR misfire artifact (isolated noise glyphs), while being
 * careful not to strip legitimate single-letter words like "a" or "I".
 */
function removeIsolatedNoiseChars(line) {
  const words = line.split(' ');
  if (words.length === 1) return line; // don't touch genuinely single-word lines
  const filtered = words.filter((w) => {
    if (w.length !== 1) return true;
    return /[aAiI0-9]/.test(w); // keep real single-char words/numbers
  });
  return filtered.join(' ');
}

/**
 * Detects lines that are part of a markdown-style table grid (from our own
 * table reconstruction) so cleaning doesn't collapse their internal spacing.
 */
function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

/**
 * Remove non-printable / control characters that OCR and some PDF parsers
 * occasionally emit (form feeds, null bytes, replacement characters, etc.),
 * while preserving normal whitespace (space, tab, newline).
 */
function stripControlChars(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFD]/g, '');
}

/**
 * Collapse repeated punctuation noise commonly left by scanned/low-quality
 * sources — long dashed/dotted separator lines, stray bullet artifacts.
 */
function removeSeparatorNoise(line) {
  // Lines that are almost entirely repeated punctuation (----, ...., ====, ****)
  if (/^[\s\-_=.*~]{6,}$/.test(line)) return '';
  return line;
}

/**
 * Strip common page-artifact lines (page numbers, "Page X of Y" footers)
 * that add no semantic value to extracted document content.
 */
function isPageArtifact(line) {
  const trimmed = line.trim();
  if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(trimmed)) return true;
  if (/^\d+\s*\/\s*\d+$/.test(trimmed)) return true; // "3/12" style page marker
  if (/^-\s*\d+\s*-$/.test(trimmed)) return true; // "- 4 -" style
  return false;
}

/**
 * Main cleaning entry point.
 * Preserves table rows (lines starting/ending with "|") as-is aside from
 * trimming, since their internal spacing is meaningful structure, not noise.
 */
function cleanExtractedText(rawText) {
  if (!rawText) return rawText;

  let text = stripControlChars(rawText);
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = normalizeUnicode(text);
  text = dehyphenate(text);
  text = normalizeTypography(text);

  const lines = text.split('\n').map((line) => {
    if (isTableRow(line)) {
      return line.trim();
    }

    let cleaned = line.replace(/\t/g, ' ');
    cleaned = cleaned.replace(/[ \u00A0]{2,}/g, ' '); // collapse runs of spaces / non-breaking spaces
    cleaned = cleaned.trim();
    cleaned = removeSeparatorNoise(cleaned);
    cleaned = removeIsolatedNoiseChars(cleaned);

    if (isPageArtifact(cleaned)) return '';

    return cleaned;
  });

  // Collapse 3+ consecutive blank lines down to a single blank line
  const collapsed = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line === '') {
      blankRun++;
      if (blankRun <= 1) collapsed.push(line);
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }

  return collapsed.join('\n').trim();
}

module.exports = { cleanExtractedText };
