// boilerplateStripper.js
// Removes the administrative boilerplate phrasing that's nearly identical
// across EVERY GS schedule record description ("This series documents...",
// "This series may include, but is not limited to...") before it gets
// embedded.
//
// WHY THIS MATTERS: measured directly against real GS-02/GS-17
// descriptions — 20-39% of a typical description's word count is this
// exact shared phrasing. Since every record's embedding includes this
// identical text, it acts as a constant shared component baked into every
// stored vector, compressing how far apart genuinely different records
// can be from each other in vector space. This is very likely the real
// cause of consistently low/tightly-clustered retrieval scores across
// this dataset — not an inherent ceiling on accuracy, but noise diluting
// the signal, the same category of fix as classificationTextCleaner.js
// (which solved the same "shared noise dilutes the embedding" problem for
// incoming documents' metadata headers).
//
// Only the DISTINCTIVE content — what actually differs between records —
// should dominate the vector.

const BOILERPLATE_PATTERNS = [
  /^This series documents\s*/i,
  /This series may include, but is not limited to:?\s*/gi,
  /This series may consist of, but is not limited to:?\s*/gi,
  /This series includes, but is not limited to:?\s*/gi,
  /but is not limited to:?\s*/gi // catches any remaining variant of the phrase alone
];

/**
 * Strips shared administrative boilerplate from a GS record description,
 * leaving only the distinctive content. Safe to call on any description —
 * if none of the patterns match, the text passes through unchanged.
 */
function stripBoilerplate(description) {
  if (!description) return description;

  let result = description;
  for (const pattern of BOILERPLATE_PATTERNS) {
    result = result.replace(pattern, '');
  }

  result = result.replace(/\s+/g, ' ').trim();

  // Safety net: if stripping removed almost everything (a very short
  // description that was ALMOST ENTIRELY boilerplate), fall back to the
  // original rather than embedding near-nothing.
  return result.length >= 15 ? result : description;
}

module.exports = { stripBoilerplate };
