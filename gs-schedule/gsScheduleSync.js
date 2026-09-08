// gsScheduleSync.js
// Given a set of parsed GS schedule records, syncs them into TWO places:
//   - Milvus: seriesNumber + embedding only (the vector index)
//   - gsScheduleMetadataStore (local JSON): all the readable fields
//
// Change detection (insert vs update vs skip) is done against the JSON
// metadata store, since Milvus no longer holds readable fields to compare.

const { performance } = require('perf_hooks');
const {
  ensureGsScheduleCollection,
  getExistingRecord,
  insertGsRecord,
  updateGsRecord,
  flushGsCollection
} = require('../milvus/gsScheduleCollection');
const { getMetadata, upsertMetadata } = require('./gsScheduleMetadataStore');
const { generateEmbedding } = require('../embeddings/embeddingGenerator');

function metadataMatches(existingMeta, record) {
  if (!existingMeta) return false;
  return existingMeta.scheduleNumber === (record.scheduleNumber || '') &&
         existingMeta.seriesName === record.seriesName &&
         existingMeta.description === record.description &&
         existingMeta.retentionPeriod === record.retentionPeriod &&
         existingMeta.dispositionMethod === record.dispositionMethod;
}

/**
 * Syncs an array of parsed GS schedule records into Milvus (vector) +
 * the JSON metadata store (readable fields).
 * Returns a per-record outcome summary, useful for showing the user
 * exactly what happened (e.g. "12 unchanged, 3 updated, 5 new").
 */
async function syncGsScheduleRecords(records) {
  const startTime = performance.now();

  // Ensures collection + schema exist (creates it on first-ever call).
  await ensureGsScheduleCollection();

  const results = { inserted: [], updated: [], skipped: [], failed: [] };

  for (const record of records) {
    // Records with no valid seriesNumber (usually caused by a multi-line
    // title splitting across a record boundary, where the extractor
    // couldn't confidently attach a number) are rejected here rather than
    // inserted — an empty string isn't a usable primary key, and since
    // insertGsRecord uses insert() not upsert(), multiple such records
    // would pile up as separate duplicate rows instead of merging.
    if (!record.seriesNumber || !record.seriesNumber.trim()) {
      results.failed.push({ seriesNumber: '(empty)', error: `Skipped "${record.seriesName}" — no valid series number could be extracted for this record.` });
      continue;
    }

    try {
      const existingInMilvus = await getExistingRecord(record.seriesNumber);
      const existingMeta = getMetadata(record.seriesNumber);

      if (existingInMilvus && metadataMatches(existingMeta, record)) {
        results.skipped.push(record.seriesNumber);
        continue;
      }

      const embeddingResult = await generateEmbedding(record.textToEmbed || record.description);
      if (!embeddingResult.vector) {
        results.failed.push({ seriesNumber: record.seriesNumber, error: embeddingResult.error });
        continue;
      }

      if (existingInMilvus) {
        await updateGsRecord(record.seriesNumber, embeddingResult.vector);
        results.updated.push(record.seriesNumber);
      } else {
        await insertGsRecord(record.seriesNumber, embeddingResult.vector);
        results.inserted.push(record.seriesNumber);
      }

      // Metadata store is always written on insert/update, keeping it in
      // sync with whatever vector was just written to Milvus.
      upsertMetadata(record);
    } catch (err) {
      results.failed.push({ seriesNumber: record.seriesNumber, error: err.message });
    }
  }

  // Flush ONCE for the whole batch, not per-record — this is the fix for
  // the measured 87-second sync bottleneck (34 records, each individually
  // flushing, vs. one flush at the end for all of them). Skipped entirely
  // if nothing actually changed, since flushing has nothing to persist.
  if (results.inserted.length > 0 || results.updated.length > 0) {
    await flushGsCollection();
  }

  const durationMs = Math.round(performance.now() - startTime);
  console.log(
    `[gsScheduleSync] Synced ${records.length} records in ${durationMs}ms: ` +
    `${results.inserted.length} inserted, ${results.updated.length} updated, ` +
    `${results.skipped.length} unchanged, ${results.failed.length} failed`
  );

  return { ...results, durationMs };
}

module.exports = { syncGsScheduleRecords };