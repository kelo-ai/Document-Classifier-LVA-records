// debugOcrWords.js
// Dumps the RAW Tesseract result object structure directly — not routed
// through ocrImage()'s word-extraction logic at all — so we can see
// exactly what shape this installed Tesseract.js version actually
// returns, instead of guessing at it a second or third time.
//
// Usage: node debugOcrWords.js "C:\path\to\file.pdf"

const fs = require('fs');
const { renderPdfToImages, getWorker, withTimeout, OCR_TIMEOUT_MS } = require('../extraction/ocrTesseract');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node debugOcrWords.js <path-to-pdf>');
  process.exit(1);
}

(async () => {
  const buffer = fs.readFileSync(filePath);
  console.log('Rendering PDF pages to images...');
  const images = await renderPdfToImages(buffer, 2.5);
  console.log('Rendered', images.length, 'page image(s).\n');

  const worker = await getWorker();

  for (let i = 0; i < images.length; i++) {
    console.log(`=== PAGE ${i + 1} — running Tesseract OCR directly ===`);
    const { data } = await withTimeout(worker.recognize(images[i]), OCR_TIMEOUT_MS, 'OCR recognition');

    console.log('Top-level keys on data:', Object.keys(data));
    console.log('');

    // Check every plausible location word-level data could live, report
    // which ones actually exist and how many items they contain.
    console.log('data.words:', Array.isArray(data.words) ? `array, length ${data.words.length}` : typeof data.words);
    console.log('data.blocks:', Array.isArray(data.blocks) ? `array, length ${data.blocks.length}` : typeof data.blocks);
    console.log('data.paragraphs:', Array.isArray(data.paragraphs) ? `array, length ${data.paragraphs.length}` : typeof data.paragraphs);
    console.log('data.lines:', Array.isArray(data.lines) ? `array, length ${data.lines.length}` : typeof data.lines);
    console.log('data.symbols:', Array.isArray(data.symbols) ? `array, length ${data.symbols.length}` : typeof data.symbols);
    console.log('');

    if (Array.isArray(data.blocks) && data.blocks.length > 0) {
      console.log('First block keys:', Object.keys(data.blocks[0]));
      console.log('First block (JSON, truncated to 2000 chars):');
      console.log(JSON.stringify(data.blocks[0], null, 2).slice(0, 2000));
    } else if (Array.isArray(data.lines) && data.lines.length > 0) {
      console.log('First line keys:', Object.keys(data.lines[0]));
      console.log('First line (JSON, truncated to 1500 chars):');
      console.log(JSON.stringify(data.lines[0], null, 2).slice(0, 1500));
    } else {
      console.log('Neither data.blocks nor data.lines has content — dumping full top-level data (excluding known-huge fields):');
      const safeCopy = { ...data };
      delete safeCopy.imageColor;
      delete safeCopy.imageGrey;
      delete safeCopy.imageBinary;
      delete safeCopy.hocr;
      delete safeCopy.tsv;
      delete safeCopy.pdf;
      delete safeCopy.box;
      delete safeCopy.unlv;
      delete safeCopy.osd;
      console.log(JSON.stringify(safeCopy, null, 2).slice(0, 3000));
    }
    console.log('');
  }

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});