// server.js
// Node.js + Express backend for document management system
// Storage: Amazon S3 (via AWS SDK v3), files handled in-memory with Multer

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const { extractText } = require('./extraction/textExtractor');

/**
 * Cheap, primitive check: does this PDF have ANY substantial real text at
 * all, reading raw pdfjs item strings directly — independent of
 * textExtractor.js's more complex line-reconstruction/cleaning logic.
 *
 * Why this exists: measured directly — a real 21-page GS-16 schedule had
 * textExtractor.js's fully-processed output come back under 20 characters
 * (triggering an 87.9-second wasted OCR run), while the SEPARATE,
 * specialized GS table extractor (which reads pdfjs positions directly,
 * no reconstruction) succeeded in 115ms on the exact same PDF. The two
 * extraction paths disagreed — this check uses the same primitive,
 * unprocessed signal the GS extractor relies on, so the OCR decision
 * matches what actually matters: is there real text in this PDF at all,
 * not whether one particular formatting pipeline handled this layout well.
 */
async function pdfHasSubstantialText(buffer, minChars = 100) {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(buffer);
    const doc = await pdfjsLib.getDocument({ data, disableWorker: true }).promise;
    let totalChars = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      for (const item of content.items) totalChars += item.str.length;
      if (totalChars >= minChars) return true; // early exit, no need to scan every page
    }
    return totalChars >= minChars;
  } catch (err) {
    return false; // if raw pdfjs itself can't read it, treat as no usable text
  }
}
const { startTimingSession } = require('./perfLogger');
const { isGsScheduleDocument, extractScheduleNumber } = require('./gs-schedule/gsScheduleParser');
const { extractGsScheduleTable } = require('./gs-schedule/gsScheduleTableExtractor');
const { extractGsScheduleTableViaOcr } = require('./gs-schedule/gsScheduleOcrTableExtractor');
const { syncGsScheduleRecords } = require('./gs-schedule/gsScheduleSync');
const { classifyDocument } = require('./gs-schedule/gsClassifier');
const { searchGsSchedule } = require('./gs-schedule/gsSearch');
const { extractWithTesseract, terminateWorker } = require('./extraction/ocrTesseract');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Config ----------
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx']);
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);

const BUCKET_NAME = process.env.AWS_BUCKET_NAME;
const REGION = process.env.AWS_REGION;

// ---------- AWS S3 Client (SDK v3) ----------
const s3Client = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

// ---------- Multer: memory storage only (no local disk writes) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const validExt = ALLOWED_EXTENSIONS.has(ext);
    const validMime = ALLOWED_MIME_TYPES.has(file.mimetype);

    if (!validExt || !validMime) {
      return cb(new Error('INVALID_FILE_TYPE'));
    }
    cb(null, true);
  }
});

app.use(express.json());
app.use(express.static('public')); // serve existing frontend

/**
 * Build the public S3 object URL (virtual-hosted-style).
 */
function buildLocationUrl(key) {
  return `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${encodeURIComponent(key)}`;
}

/**
 * Map known AWS/S3 error codes to specific, user-friendly messages.
 * Falls back to a generic message for anything unrecognized.
 */
function describeS3Error(err) {
  const code = err.Code || err.name || err.code;

  switch (code) {
    case 'NoSuchBucket':
      return 'The configured S3 bucket does not exist. Check AWS_BUCKET_NAME.';
    case 'NoSuchKey':
      return 'The requested file was not found in storage.';
    case 'AccessDenied':
      return 'AWS credentials do not have permission to perform this action.';
    case 'PermanentRedirect':
      return 'The bucket region does not match AWS_REGION in the .env file.';
    case 'CredentialsProviderError':
    case 'InvalidAccessKeyId':
      return 'AWS credentials are missing or invalid. Check .env.';
    case 'SignatureDoesNotMatch':
      return 'AWS secret access key is incorrect.';
    case 'NetworkingError':
    case 'TimeoutError':
      return 'Could not reach AWS S3. Check your internet connection.';
    default:
      return 'An unexpected storage error occurred: ' + (err.message || 'unknown error');
  }
}

/**
 * POST /upload
 * Accepts a single file under field name "document", validates it,
 * uploads it to S3 with a unique file ID, and returns metadata.
 */
app.post('/upload', (req, res) => {
  upload.single('document')(req, res, async (err) => {
    // Multer-level errors (size limit, file type, etc.) — specific messages
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          errorType: 'FILE_TOO_LARGE',
          message: 'File exceeds the 2 MB size limit. Please upload a smaller file.'
        });
      }
      if (err.message === 'INVALID_FILE_TYPE') {
        return res.status(400).json({
          success: false,
          errorType: 'INVALID_FILE_TYPE',
          message: 'Unsupported file type. Only PDF, DOC, DOCX, XLS, and XLSX files are allowed.'
        });
      }
      return res.status(400).json({
        success: false,
        errorType: 'UPLOAD_ERROR',
        message: 'File upload error: ' + err.message
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        errorType: 'NO_FILE',
        message: 'No file was selected. Please choose a file to upload.'
      });
    }

    const fileId = crypto.randomUUID();
    const safeName = req.file.originalname.replace(/\s+/g, '_');
    const objectKey = `${fileId}-${safeName}`;
    const extractedKey = `extracted/${fileId}.txt`;
    const rawExtractedKey = `extracted/${fileId}-raw.txt`;
    const uploadedAt = new Date().toISOString();
    const ext = path.extname(req.file.originalname).toLowerCase();

    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: objectKey,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        // Custom metadata stored on the S3 object itself — used later by /files
        Metadata: {
          fileid: fileId,
          originalname: encodeURIComponent(req.file.originalname),
          uploadedat: uploadedAt
        }
      }));

      // Extraction quality: 'high' (table-aware, more thorough, slower/costlier)
      // or 'low' (fast, plain text only) — sent as a form field alongside the file.
      const quality = (req.body.quality || 'low').toLowerCase() === 'high' ? 'high' : 'low';

      // Extract text from the in-memory buffer (does not block on failure)
      const perfSession = startTimingSession(`upload:${req.file.originalname}`);
      const extractionStart = Date.now();
      let { text: extractedText, rawText: rawExtractedText, error: extractionError, corrupted: isCorrupted, durationMs: libraryDurationMs } =
        await extractText(req.file.buffer, ext, quality);
      perfSession.record('library-extraction', libraryDurationMs);
      let usedOcr = false;
      let extractionMethod = 'library'; // library | ocr-text | ocr-tables
      let ocrDurationMs = 0;

      if (ext === '.pdf') {
        // OCR is now reserved for genuinely scanned/insufficient-text
        // documents at BOTH quality settings — previously, "high" quality
        // always ran full OCR regardless of whether the text layer already
        // worked, which was wasteful: measured at 44.8 seconds wasted on a
        // real 9-page digital PDF whose text layer had already succeeded
        // in 300ms, and whose GS table structure was separately extracted
        // via the fast pdfjs-based path anyway (OCR's output wasn't even
        // used for that). The dedicated coordinate-based GS table
        // extractor doesn't need OCR's table-reconstruction fallback for
        // documents that already have a real text layer.
        const generalExtractionThin = !extractedText || extractedText.trim().length < 20;
        const hasRawText = generalExtractionThin
          ? await perfSession.step('raw-text-check', () => pdfHasSubstantialText(req.file.buffer))
          : true; // skip the check entirely if the general extraction already succeeded — no ambiguity to resolve
        const isLikelyScanned = generalExtractionThin && !hasRawText;

        if (isLikelyScanned) {
          const ocrResult = await extractWithTesseract(req.file.buffer, quality);
          ocrDurationMs = ocrResult.durationMs || 0;
          perfSession.record(quality === 'high' ? 'ocr-tables' : 'ocr-text-fallback', ocrDurationMs, !!ocrResult.text);
          if (ocrResult.text) {
            extractedText = ocrResult.text;
            rawExtractedText = ocrResult.rawText;
            extractionError = null;
            isCorrupted = false;
            usedOcr = true;
            extractionMethod = quality === 'high' ? 'ocr-tables' : 'ocr-text';
          } else {
            extractionError = extractionError || ocrResult.error;
            isCorrupted = isCorrupted || ocrResult.corrupted;
          }
        }
      } else if (ext === '.docx' && quality === 'high') {
        extractionMethod = 'library-tables';
      } else if (ext === '.xls' || ext === '.xlsx') {
        extractionMethod = 'library-tables'; // sheet_to_csv already preserves rows/columns
      }

      const totalExtractionDurationMs = Date.now() - extractionStart;
      console.log(
        `[upload] Extraction for "${req.file.originalname}" (${ext}, quality=${quality}): ` +
        `${totalExtractionDurationMs}ms total (library=${libraryDurationMs}ms, ocr=${ocrDurationMs}ms), ` +
        `method=${extractionMethod}, corrupted=${isCorrupted}`
      );

      let hasExtractedText = false;
      if (extractedText) {
        try {
          await s3Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: extractedKey,
            Body: extractedText,
            ContentType: 'text/plain; charset=utf-8',
            Metadata: {
              fileid: fileId,
              extractionmethod: extractionMethod,
              quality: quality
            }
          }));
          hasExtractedText = true;

          // Store the uncleaned version too, for demonstration/comparison purposes
          if (rawExtractedText) {
            await s3Client.send(new PutObjectCommand({
              Bucket: BUCKET_NAME,
              Key: rawExtractedKey,
              Body: rawExtractedText,
              ContentType: 'text/plain; charset=utf-8',
              Metadata: { fileid: fileId }
            }));
          }
        } catch (extractUploadErr) {
          console.error('Failed to store extracted text:', extractUploadErr);
        }
      }

      // If this upload is a GS-series records retention schedule (Library of
      // Virginia format), extract its table rows directly from the PDF's
      // column coordinates — not from flattened text — and sync them into
      // the dedicated gs_schedule_records Milvus collection. Coordinate-based
      // extraction is used because it physically separates the Description,
      // Series Number, Retention, and Disposition columns using their real
      // X-positions in the PDF, so a series number can never get merged
      // into a description line the way flattened-text parsing was prone to.
      let gsScheduleStatus = null;
      if (extractedText && isGsScheduleDocument(extractedText) && ext === '.pdf') {
        try {
          let tableResult = await perfSession.step('gs-table-extraction', () => extractGsScheduleTable(req.file.buffer));

          // If the text-layer extractor found no columns at all (a scanned/
          // image PDF has no embedded text for pdfjs to read), fall back
          // to OCR-based table extraction — same column-detection logic,
          // sourced from Tesseract word positions instead.
          if (tableResult.error && tableResult.records.length === 0) {
            console.log('[upload] PDF text-layer table extraction found no columns — trying OCR-based extraction (likely a scanned document)');
            tableResult = await perfSession.step('gs-table-extraction-ocr-fallback', () => extractGsScheduleTableViaOcr(req.file.buffer));
          }

          const scheduleNumber = tableResult.scheduleNumber || extractScheduleNumber(extractedText);

          // Full structured JSON logged for direct verification against the
          // source PDF — check this against the actual document if anything
          // looks off, rather than guessing from summary counts alone.
          console.log(`[upload] Detected GS schedule document (${scheduleNumber}), extracted ${tableResult.records.length} records`);
          console.log('[upload] GS schedule parsed JSON:', JSON.stringify(tableResult.records, null, 2));
          console.log('[upload] GS schedule RAW column debug:', JSON.stringify(tableResult.debugColumns, null, 2));

          if (tableResult.error) {
            gsScheduleStatus = { scheduleNumber, parsedCount: 0, error: tableResult.error };
          } else if (tableResult.records.length > 0) {
            const syncResult = await syncGsScheduleRecords(tableResult.records);
            perfSession.record('gs-schedule-sync', syncResult.durationMs || 0);
            gsScheduleStatus = { scheduleNumber, parsedCount: tableResult.records.length, ...syncResult };
          } else {
            gsScheduleStatus = { scheduleNumber, parsedCount: 0, error: 'Detected as a GS schedule but no records could be extracted from its table columns.' };
          }
        } catch (gsErr) {
          console.error('[upload] GS schedule table extraction failed (non-fatal):', gsErr.message);
          gsScheduleStatus = { scheduleNumber: null, parsedCount: 0, error: gsErr.message };
        }
      }

      perfSession.logSummary();

      return res.status(201).json({
        success: true,
        message: 'File uploaded successfully.',
        fileId: fileId,
        originalName: req.file.originalname,
        key: objectKey,
        size: req.file.size,
        location: buildLocationUrl(objectKey),
        uploadedAt: uploadedAt,
        extraction: {
          success: hasExtractedText,
          error: extractionError,
          corrupted: isCorrupted || false,
          usedOcr: usedOcr,
          method: extractionMethod,
          quality: quality,
          durationMs: totalExtractionDurationMs,
          // Short previews only — full text available via GET /extract/:fileId
          preview: extractedText ? extractedText.slice(0, 300) : null,
          rawPreview: rawExtractedText ? rawExtractedText.slice(0, 300) : null
        },
        gsSchedule: gsScheduleStatus,
        // Nested object kept for frontend compatibility
        file: {
          name: req.file.originalname,
          savedAs: objectKey,
          size: req.file.size
        }
      });
    } catch (s3Err) {
      console.error('S3 upload failed:', s3Err);
      return res.status(502).json({
        success: false,
        errorType: 'S3_UPLOAD_FAILED',
        message: describeS3Error(s3Err)
      });
    }
  });
});

/**
 * GET /extract/:fileId
 * Retrieves both the cleaned and raw (uncleaned) extracted text for a given file,
 * stored at extracted/<fileId>.txt and extracted/<fileId>-raw.txt
 */
app.get('/extract/:fileId', async (req, res) => {
  const { fileId } = req.params;
  const extractedKey = `extracted/${fileId}.txt`;
  const rawExtractedKey = `extracted/${fileId}-raw.txt`;

  async function readTextObject(key) {
    const data = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    const chunks = [];
    for await (const chunk of data.Body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  try {
    const text = await readTextObject(extractedKey);

    // Raw version is optional — older files uploaded before this feature won't have one
    let rawText = null;
    try {
      rawText = await readTextObject(rawExtractedKey);
    } catch (rawErr) {
      // No raw version stored for this file — not an error, just not available
    }

    return res.json({ success: true, fileId, text, rawText });
  } catch (s3Err) {
    if (s3Err.name === 'NoSuchKey') {
      return res.status(404).json({
        success: false,
        errorType: 'EXTRACTION_NOT_FOUND',
        message: 'No extracted text found for this file (extraction may have failed at upload time).'
      });
    }
    console.error('Extracted text retrieval failed:', s3Err);
    return res.status(502).json({
      success: false,
      errorType: 'S3_DOWNLOAD_FAILED',
      message: describeS3Error(s3Err)
    });
  }
});

/**
 * GET /files
 * Lists all objects in the S3 bucket, enriched with per-file metadata
 * (fileId, original name, uploadedAt) for the dashboard.
 */
app.get('/files', async (req, res) => {
  try {
    const listData = await s3Client.send(new ListObjectsV2Command({ Bucket: BUCKET_NAME }));
    // Exclude internal companion objects (extracted text files) from the visible list
    const objects = (listData.Contents || []).filter((obj) => !obj.Key.startsWith('extracted/'));

    // Fetch metadata for each object in parallel
    const files = await Promise.all(objects.map(async (obj) => {
      let metadata = {};
      try {
        const head = await s3Client.send(new HeadObjectCommand({
          Bucket: BUCKET_NAME,
          Key: obj.Key
        }));
        metadata = head.Metadata || {};
      } catch (headErr) {
        console.error(`Could not read metadata for ${obj.Key}:`, headErr.message);
      }

      // Look up extraction method/quality from the companion extracted-text object, if any
      let extractionMethod = null;
      let quality = null;
      if (metadata.fileid) {
        try {
          const extractedHead = await s3Client.send(new HeadObjectCommand({
            Bucket: BUCKET_NAME,
            Key: `extracted/${metadata.fileid}.txt`
          }));
          extractionMethod = (extractedHead.Metadata || {}).extractionmethod || null;
          quality = (extractedHead.Metadata || {}).quality || null;
        } catch (extractedHeadErr) {
          // No extracted text object exists for this file — leave as null
        }
      }

      return {
        fileId: metadata.fileid || null,
        originalName: metadata.originalname ? decodeURIComponent(metadata.originalname) : obj.Key,
        key: obj.Key,
        size: obj.Size,
        location: buildLocationUrl(obj.Key),
        uploadedAt: metadata.uploadedat || null,
        lastModified: obj.LastModified,
        extractionMethod: extractionMethod,
        quality: quality
      };
    }));

    return res.json({ success: true, files });
  } catch (s3Err) {
    console.error('S3 list failed:', s3Err);
    return res.status(502).json({
      success: false,
      errorType: 'S3_LIST_FAILED',
      message: describeS3Error(s3Err)
    });
  }
});

/**
 * POST /reprocess-gs/:key
 * Re-runs GS schedule extraction + sync on a file that's ALREADY in S3 —
 * no re-upload needed. Useful for re-testing extraction logic after a code
 * change, without creating a duplicate S3 object or going through the
 * browser upload form again.
 */
/**
 * POST /classify-gs
 * Body: { text: "..." }
 * Classifies arbitrary document text against the GS schedule collection:
 * finds the top 3 candidate series by vector similarity, asks the LLM to
 * pick the best match with reasoning, then returns the full ground-truth
 * metadata for that choice (never LLM-generated facts).
 */
/**
 * GET /search-gs?q=...
 * Pure retrieval — no LLM. Returns the top 3 GS record series closest in
 * meaning to the query, each with full metadata and a similarity score.
 */
app.get('/search-gs', async (req, res) => {
  const query = req.query.q;
  if (!query || !query.trim()) {
    return res.status(400).json({ success: false, message: 'Provide a query via ?q=' });
  }
  const perfSession = startTimingSession(`search-gs:"${query}"`);
  const result = await perfSession.step('search', () => searchGsSchedule(query, 3));
  perfSession.logSummary();
  return res.json(result);
});

app.post('/classify-gs', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ success: false, message: 'Provide document text in the request body as { "text": "..." }' });
  }

  const perfSession = startTimingSession('classify-gs:pasted-text');
  const result = await perfSession.step('classify', () => classifyDocument(text));
  perfSession.logSummary();
  if (!result.success) {
    return res.status(422).json(result);
  }
  return res.json(result);
});

/**
 * POST /classify-gs-file/:fileId
 * Completes the classification flow for an ALREADY-UPLOADED document —
 * pulls its cleaned extracted text (already stored at upload time) and
 * runs it through the same classify pipeline as /classify-gs, without
 * needing to re-paste the document's text manually.
 */
app.post('/classify-gs-file/:fileId', async (req, res) => {
  const { fileId } = req.params;
  const extractedKey = `extracted/${fileId}.txt`;
  const perfSession = startTimingSession(`classify-gs-file:${fileId}`);

  try {
    const data = await perfSession.step('s3-fetch-text', () =>
      s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: extractedKey }))
    );
    const chunks = [];
    for await (const chunk of data.Body) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf-8');

    if (!text.trim()) {
      return res.status(422).json({ success: false, message: 'No extracted text found for this file.' });
    }

    const result = await perfSession.step('classify', () => classifyDocument(text));
    perfSession.logSummary();
    if (!result.success) {
      return res.status(422).json(result);
    }
    return res.json(result);
  } catch (err) {
    perfSession.logSummary();
    if (err.name === 'NoSuchKey') {
      return res.status(404).json({ success: false, message: 'No extracted text found for this fileId — has it been uploaded?' });
    }
    console.error('[classify-gs-file] Failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
});

app.post('/reprocess-gs/:key', async (req, res) => {
  const { key } = req.params;

  try {
    const data = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    const chunks = [];
    for await (const chunk of data.Body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const tableResult = await extractGsScheduleTable(buffer);
    const scheduleNumber = tableResult.scheduleNumber;

    console.log(`[reprocess-gs] Re-extracted "${key}" (${scheduleNumber}): ${tableResult.records.length} records`);
    console.log('[reprocess-gs] RAW column debug:', JSON.stringify(tableResult.debugColumns, null, 2));
    console.log('[reprocess-gs] Parsed records:', JSON.stringify(tableResult.records, null, 2));

    if (tableResult.error) {
      return res.status(422).json({ success: false, message: tableResult.error });
    }

    const syncResult = await syncGsScheduleRecords(tableResult.records);

    return res.json({
      success: true,
      scheduleNumber,
      parsedCount: tableResult.records.length,
      debugColumns: tableResult.debugColumns,
      records: tableResult.records,
      sync: syncResult
    });
  } catch (err) {
    console.error('[reprocess-gs] Failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
});

/**
 * GET /download/:key
 * Streams the requested object from S3 back to the client through this server.
 */
app.get('/download/:key', async (req, res) => {
  const { key } = req.params;

  try {
    const data = await s3Client.send(new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    }));

    res.setHeader('Content-Disposition', `attachment; filename="${key}"`);
    if (data.ContentType) {
      res.setHeader('Content-Type', data.ContentType);
    }

    data.Body.pipe(res);
  } catch (s3Err) {
    if (s3Err.name === 'NoSuchKey') {
      return res.status(404).json({
        success: false,
        errorType: 'FILE_NOT_FOUND',
        message: 'The requested file was not found in storage.'
      });
    }
    console.error('S3 download failed:', s3Err);
    return res.status(502).json({
      success: false,
      errorType: 'S3_DOWNLOAD_FAILED',
      message: describeS3Error(s3Err)
    });
  }
});

/**
 * DELETE /delete/:key
 * Permanently deletes the specified object from the S3 bucket.
 */
app.delete('/delete/:key', async (req, res) => {
  const { key } = req.params;

  try {
    // Look up fileId first so the companion extracted-text object can be cleaned up too
    let fileId = null;
    try {
      const head = await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
      fileId = head.Metadata && head.Metadata.fileid;
    } catch (headErr) {
      // If the head lookup fails, proceed with deleting just the main object
    }

    await s3Client.send(new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    }));

    if (fileId) {
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: BUCKET_NAME,
          Key: `extracted/${fileId}.txt`
        }));
      } catch (extractDeleteErr) {
        console.error('Failed to delete companion extracted text:', extractDeleteErr.message);
      }
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: BUCKET_NAME,
          Key: `extracted/${fileId}-raw.txt`
        }));
      } catch (rawDeleteErr) {
        // Raw version may not exist for older files — not an error
      }
    }

    return res.json({
      success: true,
      message: `File "${key}" deleted successfully.`
    });
  } catch (s3Err) {
    console.error('S3 delete failed:', s3Err);
    return res.status(502).json({
      success: false,
      errorType: 'S3_DELETE_FAILED',
      message: describeS3Error(s3Err)
    });
  }
});

// ---------- Fallback error handler ----------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    errorType: 'INTERNAL_ERROR',
    message: 'Internal server error.'
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// Release the persistent Tesseract worker cleanly on shutdown (Ctrl+C, etc.)
process.on('SIGINT', async () => {
  console.log('\nShutting down — releasing OCR worker...');
  await terminateWorker();
  process.exit(0);
});