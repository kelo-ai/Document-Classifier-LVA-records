// gsScheduleCollection.js
// Creates the Milvus collection + schema for GS-02 schedule records.
// This is the "collection and schema" step — no embedding model involved
// yet. The vector field is reserved with the right dimension (384, matching
// all-MiniLM-L6-v2, same model already used elsewhere in this project) so
// the schema is ready the moment embeddings get wired in.

const { MilvusClient, DataType } = require('@zilliz/milvus2-sdk-node');

const MILVUS_ADDRESS = process.env.MILVUS_ADDRESS || 'localhost:19530';
const GS_COLLECTION_NAME = 'gs_schedule_records';
const VECTOR_DIM = 384;

let client = null;
let collectionReady = false;

/**
 * Milvus schema — deliberately minimal:
 *   - seriesNumber : the 6-digit record series ID (primary key)
 *   - embedding    : vector representation of the record's textToEmbed
 *                    (name + description), for semantic search
 *
 * All readable metadata (seriesName, description, retentionPeriod,
 * dispositionMethod, scheduleNumber) lives in a SEPARATE JSON file
 * (gsScheduleMetadataStore.js), keyed by the same seriesNumber. Milvus
 * only answers "which seriesNumbers are closest in meaning to this
 * query?" — looking up what those IDs actually mean is a second step
 * against the metadata store.
 */
async function ensureGsScheduleCollection() {
  if (!client) {
    client = new MilvusClient({ address: MILVUS_ADDRESS });
  }
  if (collectionReady) return client;

  const exists = await client.hasCollection({ collection_name: GS_COLLECTION_NAME });
  if (!exists.value) {
    await client.createCollection({
      collection_name: GS_COLLECTION_NAME,
      fields: [
        { name: 'seriesNumber', data_type: DataType.VarChar, max_length: 20, is_primary_key: true },
        { name: 'embedding', data_type: DataType.FloatVector, dim: VECTOR_DIM }
      ]
    });

    await client.createIndex({
      collection_name: GS_COLLECTION_NAME,
      field_name: 'embedding',
      index_type: 'IVF_FLAT',
      metric_type: 'COSINE',
      params: { nlist: 128 }
    });

    console.log(`Created collection "${GS_COLLECTION_NAME}" with schema + index.`);
  } else {
    console.log(`Collection "${GS_COLLECTION_NAME}" already exists — skipping creation.`);
  }

  await client.loadCollection({ collection_name: GS_COLLECTION_NAME });
  collectionReady = true;
  return client;
}

/**
 * Check whether a record with this seriesNumber already exists in Milvus.
 * Only existence is checked here — Milvus no longer holds the readable
 * fields to compare against; that comparison happens against the separate
 * JSON metadata store instead (see gsScheduleMetadataStore.js).
 */
async function getExistingRecord(seriesNumber) {
  const milvus = await ensureGsScheduleCollection();
  const result = await milvus.query({
    collection_name: GS_COLLECTION_NAME,
    filter: `seriesNumber == "${seriesNumber}"`,
    output_fields: ['seriesNumber']
  });
  return (result.data && result.data.length > 0) ? result.data[0] : null;
}

/**
 * Insert a brand-new record's ID + embedding into the collection.
 * Does NOT flush — flushing is batched once at the end of a sync run
 * (see flushGsCollection), since flushing after every single record is a
 * genuinely expensive operation (measured: flushing per-record turned a
 * 34-record sync into 87 seconds; batching one flush for the whole run
 * avoids paying that cost N times over).
 */
async function insertGsRecord(seriesNumber, embedding) {
  const milvus = await ensureGsScheduleCollection();
  await milvus.insert({
    collection_name: GS_COLLECTION_NAME,
    data: [{ seriesNumber, embedding }]
  });
}

/**
 * Update an existing record's embedding (content changed since last
 * upload) — Milvus upsert replaces the row entirely by primary key.
 * Also does not flush per-call, same reasoning as insertGsRecord.
 */
async function updateGsRecord(seriesNumber, embedding) {
  const milvus = await ensureGsScheduleCollection();
  await milvus.upsert({
    collection_name: GS_COLLECTION_NAME,
    data: [{ seriesNumber, embedding }]
  });
}

/**
 * Flushes the collection ONCE — call this after a batch of inserts/updates
 * completes, not after each individual one.
 */
async function flushGsCollection() {
  const milvus = await ensureGsScheduleCollection();
  await milvus.flushSync({ collection_names: [GS_COLLECTION_NAME] });
}

/**
 * Deletes a record's vector by seriesNumber.
 */
async function deleteGsRecord(seriesNumber) {
  const milvus = await ensureGsScheduleCollection();
  await milvus.delete({
    collection_name: GS_COLLECTION_NAME,
    filter: `seriesNumber == "${seriesNumber}"`
  });
  await milvus.flushSync({ collection_names: [GS_COLLECTION_NAME] });
}

/**
 * Finds the topK series most similar in meaning to a query embedding —
 * the "top 3 candidates" step of the classification pipeline. Returns
 * only {seriesNumber, score}; the caller looks up full readable data
 * from gsScheduleMetadataStore separately.
 */
async function searchSimilarSeries(queryEmbedding, topK = 3) {
  const milvus = await ensureGsScheduleCollection();
  const result = await milvus.search({
    collection_name: GS_COLLECTION_NAME,
    vector: queryEmbedding,
    limit: topK,
    output_fields: ['seriesNumber'],
    consistency_level: 'Strong'
  });
  return (result.results || []).map((r) => ({ seriesNumber: r.seriesNumber, score: r.score }));
}

/**
 * Fetches the raw embedding vectors for a set of seriesNumbers — needed
 * for Intra-Context Similarity, which compares candidates to EACH OTHER
 * (not to the query), so it needs the actual vectors, not just scores.
 */
async function getEmbeddingsByIds(seriesNumbers) {
  if (seriesNumbers.length === 0) return {};
  const milvus = await ensureGsScheduleCollection();
  const filter = seriesNumbers.map((sn) => `seriesNumber == "${sn}"`).join(' || ');
  const result = await milvus.query({
    collection_name: GS_COLLECTION_NAME,
    filter,
    output_fields: ['seriesNumber', 'embedding']
  });
  const map = {};
  (result.data || []).forEach((row) => { map[row.seriesNumber] = row.embedding; });
  return map;
}

module.exports = {
  ensureGsScheduleCollection,
  getExistingRecord,
  insertGsRecord,
  updateGsRecord,
  deleteGsRecord,
  searchSimilarSeries,
  getEmbeddingsByIds,
  flushGsCollection,
  GS_COLLECTION_NAME,
  VECTOR_DIM
};

// Allow running this file directly to just set up the collection:
//   node gsScheduleCollection.js
if (require.main === module) {
  ensureGsScheduleCollection()
    .then(() => {
      console.log('GS schedule collection is ready.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed to set up GS schedule collection.');
      console.error('Error details:', err);
      console.error('Error code:', err && err.code);
      console.error('Error message:', err && err.message);
      console.error('Error details field:', err && err.details);
      process.exit(1);
    });
}