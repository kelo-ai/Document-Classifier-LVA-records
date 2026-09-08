// reprocessAllGs.js
// Reprocesses every file already in S3 through GS schedule detection +
// extraction + sync — no re-upload needed, no duplicate S3 objects.
// Useful after node resetMilvus.js, to repopulate Milvus + the metadata
// store from files that are already sitting in your bucket.
//
// Run with: node reprocessAllGs.js
// (server.js must already be running — this calls its own HTTP API)

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

(async () => {
  console.log('Fetching file list from S3...');
  const filesRes = await fetch(`${BASE_URL}/files`);
  const filesData = await filesRes.json();

  if (!filesData.success) {
    console.error('Could not list files:', filesData.message);
    return;
  }

  const files = (filesData.files || []).filter((f) => f.originalName.toLowerCase().endsWith('.pdf'));
  console.log(`Found ${files.length} PDF files in S3 (non-PDF files skipped).\n`);

  let gsDetectedCount = 0;
  let notGsCount = 0;
  let failedCount = 0;

  for (const file of files) {
    process.stdout.write(`Reprocessing "${file.originalName}" (${file.key})... `);
    try {
      const res = await fetch(`${BASE_URL}/reprocess-gs/${encodeURIComponent(file.key)}`, { method: 'POST' });
      const data = await res.json();

      if (data.success) {
        console.log(`✓ ${data.scheduleNumber} — ${data.parsedCount} records (${data.sync.inserted.length} inserted, ${data.sync.updated.length} updated, ${data.sync.skipped.length} unchanged)`);
        gsDetectedCount++;
      } else {
        console.log(`— not a GS schedule or no records found (${data.message || 'skipped'})`);
        notGsCount++;
      }
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      failedCount++;
    }
  }

  console.log(`\nDone. ${gsDetectedCount} GS schedules reprocessed, ${notGsCount} skipped (not GS documents), ${failedCount} failed.`);
})().catch((err) => {
  console.error('Reprocessing failed:', err.message);
});
