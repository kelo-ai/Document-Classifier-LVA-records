// resetMilvus.js
// Drops BOTH Milvus collections (document_embeddings and gs_schedule_records)
// for a clean testing slate. Both collections get recreated automatically
// the next time your app uploads a file — no manual recreation needed.
// Run with: node resetMilvus.js

const { MilvusClient } = require('@zilliz/milvus2-sdk-node');

const MILVUS_ADDRESS = process.env.MILVUS_ADDRESS || 'localhost:19530';
const COLLECTIONS = ['document_embeddings', 'gs_schedule_records'];

(async () => {
  const client = new MilvusClient({ address: MILVUS_ADDRESS });

  for (const name of COLLECTIONS) {
    const exists = await client.hasCollection({ collection_name: name });
    if (!exists.value) {
      console.log(`"${name}" — doesn't exist, nothing to drop.`);
      continue;
    }
    await client.dropCollection({ collection_name: name });
    console.log(`"${name}" — dropped.`);
  }

  console.log('\nAll collections cleared. They will be recreated automatically on your next upload.');
})().catch((err) => {
  console.error('Failed to reset Milvus:', err.message);
});
