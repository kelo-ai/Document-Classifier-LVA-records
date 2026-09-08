// debugGsExtract.js
// Runs GS schedule table extraction directly against a local PDF file —
// no upload, no S3, no Milvus. Just points at a file and prints both the
// parsed records and the raw per-column debug data.
//
// Usage: node debugGsExtract.js "C:\path\to\GS-17.pdf"

const fs = require('fs');
const { extractGsScheduleTable } = require('../gs-schedule/gsScheduleTableExtractor');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node debugGsExtract.js <path-to-pdf>');
  process.exit(1);
}

(async () => {
  const buffer = fs.readFileSync(filePath);
  const result = await extractGsScheduleTable(buffer);

  console.log('=== SCHEDULE NUMBER ===');
  console.log(result.scheduleNumber);

  console.log('\n=== ERROR (if any) ===');
  console.log(result.error);

  console.log('\n=== RECORD COUNT ===');
  console.log(result.records.length);

  console.log('\n=== RAW COLUMN DEBUG ===');
  console.log(JSON.stringify(result.debugColumns, null, 2));

  console.log('\n=== PARSED RECORDS ===');
  console.log(JSON.stringify(result.records, null, 2));
})().catch((err) => {
  console.error('Extraction failed:', err.message);
});
