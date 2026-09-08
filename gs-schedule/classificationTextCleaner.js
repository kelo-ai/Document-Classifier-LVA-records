// classificationTextCleaner.js
// Strips structural/metadata noise from a document's text BEFORE it gets
// embedded for retrieval — improving search accuracy on real-world
// documents that mix short "Label: Value" metadata fields (Unit, Zone,
// Document ID, Status, dates) with the actual narrative content that
// carries the real semantic signal.
//
// Why this matters: the whole document gets averaged into ONE embedding
// vector. Metadata fields ("Unit: 05", "Zone: Foxtrot") dilute that
// average toward generic "form/log" territory, drowning out the few
// sentences that actually describe what the document is about — observed
// directly in testing: a returned-check/vendor-payment document wrapped in
// police-report-style metadata failed to retrieve "Accounts Payable" at
// all, because the metadata noise pulled the embedding toward
// case-log-flavored candidates instead.
//
// IMPORTANT: this cleaning is applied ONLY to the copy of the text used
// for embedding/retrieval. The LLM classification step still receives the
// FULL original text (including metadata) — the LLM is good at ignoring
// irrelevant fields on its own; it's the embedding step that has no such
// filtering ability, since it just averages everything together.

/**
 * If the document has a clearly-marked narrative/body/description section
 * (common in incident reports, forms, and logs — "Narrative:", "Summary:",
 * "Description:", "Details:"), extracts ONLY that section and discards
 * everything before it — including the document's own title/letterhead.
 *
 * This matters more than stripping small metadata fields: a document's
 * title or organizational letterhead (e.g. "CHESTERFIELD COUNTY POLICE
 * DEPARTMENT") can dominate the averaged embedding even when it's
 * completely incidental to the document's actual retention category —
 * observed directly in testing, where stripping metadata fields alone
 * INCREASED the header's relative weight in the remaining text instead
 * of reducing the problem.
 *
 * Returns null if no such marker is found, so the caller can fall back
 * to the metadata-stripping approach instead.
 */
function extractNarrativeSection(text) {
  const match = text.match(/(?:Narrative|Summary|Description|Details|Notes)\s*(?:\/[^:]*)?:\s*([\s\S]+)/i);
  if (!match) return null;

  const body = match[1]
    .replace(/^\s*\d{1,3}[.)]\s*/gm, '') // strip numbered list markers, keep content
    .replace(/\s+/g, ' ')
    .trim();

  return body.length >= 30 ? body : null;
}

/**
 * A line is "metadata noise" if it looks like a short field label followed
 * by a short value — not a full sentence. Real narrative sentences are
 * longer, contain verbs, and don't fit this shape.
 */
function isMetadataLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // Pattern: "Label: Value" or "Label - Value", where the label is short
  // (a few words, no sentence-ending punctuation) and the whole line is
  // short enough to plausibly be a field, not a sentence.
  const labelValueMatch = trimmed.match(/^([A-Za-z][A-Za-z\s/]{1,25}):\s*(.+)$/);
  if (labelValueMatch) {
    const label = labelValueMatch[1].trim();
    const value = labelValueMatch[2].trim();
    // A real sentence starting with "Label: text..." would have a long,
    // prose-like value (multiple clauses, ends in a period). A metadata
    // field's value is short and doesn't read as a sentence.
    const valueLooksLikeSentence = value.length > 60 || /[.!?]\s+\S/.test(value);
    if (!valueLooksLikeSentence) return true;
  }

  // Standalone codes/IDs/reference numbers on their own line
  if (/^(Document ID|Reference No\.?|Ref\.? No\.?|Unit|Zone|Status|Case No\.?|File No\.?)\s*:/i.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Removes leading numbered-list markers ("01.", "1)", "- ") from a line,
 * WITHOUT discarding the actual content that follows — numbered narrative
 * points still carry real signal, only the numbering itself is noise.
 */
function stripListMarker(line) {
  return line.replace(/^\s*(\d{1,3}[.)]\s+|-\s+)/, '');
}

/**
 * Main entry point: returns a cleaned version of the text with metadata
 * lines removed, for use as embedding input. Never call this on text meant
 * for the LLM's own reasoning step — only for the retrieval/embedding path.
 */
function extractSalientText(text) {
  if (!text) return text;

  // Prefer isolating a clearly-marked narrative/body section — this
  // discards title/header branding entirely, which matters more than
  // trimming metadata fields (see extractNarrativeSection's comment).
  const narrative = extractNarrativeSection(text);
  if (narrative) return narrative;

  const lines = text.split(/\n|(?<=\.)\s{2,}/); // split on newlines or sentence-like breaks
  const kept = lines
    .map((line) => line.trim())
    .filter((line) => line && !isMetadataLine(line))
    .map(stripListMarker);

  const result = kept.join(' ').replace(/\s+/g, ' ').trim();

  // Safety net: if cleaning stripped almost everything (e.g. a document
  // that's ALL metadata with no narrative), fall back to the original
  // text rather than embedding something too short to be meaningful.
  return result.length >= 30 ? result : text;
}

module.exports = { extractSalientText, extractNarrativeSection, isMetadataLine };