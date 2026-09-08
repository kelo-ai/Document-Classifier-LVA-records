// milvusClient.js
// Client integration for Milvus — the vector database that stores document
// text embeddings for semantic search ("find documents about X" instead of
// exact keyword matching).
//
// Milvus itself runs as a separate service (see docker-compose.yml) — this
// file only connects to it as a client, same relationship your app already
// has with S3 (S3 is the file store; Milvus is the "meaning" index).

const { MilvusClient, DataType } = require('@zilliz/milvus2-sdk-node');

const MILVUS_ADDRESS = process.env.MILVUS_ADDRESS || 'localhost:19530';
const COLLECTION_NAME = 'document_embeddings';
const VECTOR_DIM = 384; // matches all-MiniLM-L6-v2 output size

let client = null;
let collectionReady = false;

/**
 * Connects to Milvus (lazily, once) and ensures the collection + index exist.
 * Safe to call on every request — it's a no-op after the first successful setup.
 */
async function ensureCollection() {
  if (!client) {
    client = new MilvusClient({ address: MILVUS_ADDRESS });
  }
  if (collectionReady) return client;

  const exists = await client.hasCollection({ collection_name: COLLECTION_NAME });
  if (!exists.value) {
    await client.createCollection({
      collection_name: COLLECTION_NAME,
      fields: [
        { name: 'fileId', data_type: DataType.VarChar, max_length: 64, is_primary_key: true },
        { name: 'originalName', data_type: DataType.VarChar, max_length: 512 },
        { name: 'key', data_type: DataType.VarChar, max_length: 512 },
        // A snippet of the actual extracted text — stored alongside the vector so
        // search results can show *what text* matched, not just a filename/score.
        { name: 'textSnippet', data_type: DataType.VarChar, max_length: 1000 },
        { name: 'embedding', data_type: DataType.FloatVector, dim: VECTOR_DIM }
      ]
    });

    await client.createIndex({
      collection_name: COLLECTION_NAME,
      field_name: 'embedding',
      index_type: 'IVF_FLAT',
      metric_type: 'COSINE',
      params: { nlist: 128 }
    });
  }

  await client.loadCollection({ collection_name: COLLECTION_NAME });
  collectionReady = true;
  return client;
}

/**
 * Insert (or upsert) a document's embedding into Milvus, keyed by fileId —
 * called after successful text extraction + embedding generation on upload.
 */
async function upsertDocumentEmbedding({ fileId, originalName, key, textSnippet, embedding }) {
  try {
    const milvus = await ensureCollection();
    await milvus.upsert({
      collection_name: COLLECTION_NAME,
      data: [{ fileId, originalName, key, textSnippet: textSnippet || '', embedding }]
    });

    // Milvus buffers new inserts before they're searchable — flush forces
    // them to be immediately queryable instead of waiting for an automatic
    // background flush. Fine for this app's upload volume; would need
    // rethinking (batched flushes) at high-throughput scale.
    await milvus.flushSync({ collection_names: [COLLECTION_NAME] });

    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: 'Milvus upsert failed: ' + err.message };
  }
}

/**
 * Delete a document's embedding from Milvus — called when a file is deleted
 * from S3, so the search index doesn't reference a file that no longer exists.
 */
async function deleteDocumentEmbedding(fileId) {
  try {
    const milvus = await ensureCollection();
    await milvus.delete({
      collection_name: COLLECTION_NAME,
      filter: `fileId == "${fileId}"`
    });
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: 'Milvus delete failed: ' + err.message };
  }
}

/**
 * Semantic search: given a query embedding, find the most similar documents
 * by meaning (cosine similarity), not exact keyword matching.
 */
async function searchSimilarDocuments(queryEmbedding, topK = 5) {
  try {
    const milvus = await ensureCollection();
    const result = await milvus.search({
      collection_name: COLLECTION_NAME,
      vector: queryEmbedding,
      limit: topK,
      output_fields: ['fileId', 'originalName', 'key', 'textSnippet'],
      consistency_level: 'Strong'
    });
    return { results: result.results, error: null };
  } catch (err) {
    return { results: [], error: 'Milvus search failed: ' + err.message };
  }
}

module.exports = { ensureCollection, upsertDocumentEmbedding, deleteDocumentEmbedding, searchSimilarDocuments };
