// dropCollection.js
// One-time utility: drops the document_embeddings collection so the app
// recreates it with the current schema on the next upload.
// Run with: node dropCollection.js

const { MilvusClient } = require('@zilliz/milvus2-sdk-node');

const MILVUS_ADDRESS = process.env.MILVUS_ADDRESS || 'localhost:19530';
const COLLECTION_NAME = 'document_embeddings';

(async () => {
  const client = new MilvusClient({ address: MILVUS_ADDRESS });

  const exists = await client.hasCollection({ collection_name: COLLECTION_NAME });
  if (!exists.value) {
    console.log(`Collection "${COLLECTION_NAME}" doesn't exist — nothing to drop.`);
    return;
  }

  await client.dropCollection({ collection_name: COLLECTION_NAME });
  console.log(`Dropped collection "${COLLECTION_NAME}". It will be recreated automatically on your next upload.`);
})().catch((err) => {
  console.error('Failed to drop collection:', err.message);
});
