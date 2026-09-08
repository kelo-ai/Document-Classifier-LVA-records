// checkMilvusData.js
// Quick command-line check of what's actually stored — Milvus (vectors)
// and the JSON metadata store (readable fields), combined into one
// listing. Run with: node checkMilvusData.js

const { MilvusClient } = require('@zilliz/milvus2-sdk-node');
const { loadMetadata } = require('../gs-schedule/gsScheduleMetadataStore');

const MILVUS_ADDRESS = process.env.MILVUS_ADDRESS || 'localhost:19530';

(async () => {
  const client = new MilvusClient({ address: MILVUS_ADDRESS });

  const exists = await client.hasCollection({ collection_name: 'gs_schedule_records' });
  if (!exists.value) {
    console.log('"gs_schedule_records" — does not exist yet.');
    return;
  }

  const stats = await client.getCollectionStatistics({ collection_name: 'gs_schedule_records' });
  console.log(`"gs_schedule_records" — row count in Milvus: ${stats.data.row_count}`);

  await client.loadCollection({ collection_name: 'gs_schedule_records' });

  // Fetch all seriesNumbers from Milvus (no filter needed — just list everything)
  const result = await client.query({
    collection_name: 'gs_schedule_records',
    filter: 'seriesNumber like "%"', // matches every row, avoids the != "" filter that was returning nothing
    output_fields: ['seriesNumber'],
    limit: 1000
  });

  const seriesNumbers = (result.data || []).map((r) => r.seriesNumber);
  const metadata = loadMetadata();

  console.log(`\nRecords (${seriesNumbers.length} in Milvus, ${Object.keys(metadata).length} in metadata store):`);
  seriesNumbers.sort().forEach((sn) => {
    const meta = metadata[sn];
    if (!meta) {
      console.log(`  ${sn} — [WARNING: in Milvus but missing from metadata store]`);
    } else {
      console.log(`  ${sn} — ${meta.seriesName} — ${meta.retentionPeriod} — ${meta.dispositionMethod} (schedule: ${meta.scheduleNumber})`);
    }
  });

  // Flag any orphaned metadata entries too — in metadata but not in Milvus
  const milvusSet = new Set(seriesNumbers);
  const orphaned = Object.keys(metadata).filter((sn) => !milvusSet.has(sn));
  if (orphaned.length > 0) {
    console.log(`\n[WARNING] ${orphaned.length} entries exist in metadata store but NOT in Milvus:`, orphaned.join(', '));
  }
})().catch((err) => {
  console.error('Failed to check data:', err.message);
});
