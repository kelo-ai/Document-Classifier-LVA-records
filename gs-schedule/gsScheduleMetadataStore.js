// gsScheduleMetadataStore.js
// Stores the readable metadata for each GS schedule record (name,
// description, retention period, disposition method) in a local JSON
// file, separate from Milvus. Milvus only holds seriesNumber + embedding
// (see gsScheduleCollection.js) — this file is the "other half": a lookup
// table from seriesNumber to the actual human-readable data.
//
// A search flow becomes two steps: Milvus finds the closest matching
// seriesNumbers by vector similarity, then this store is used to fetch
// what those seriesNumbers actually mean.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'gsScheduleMetadata.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '{}');
}

/**
 * Loads the entire metadata store: { [seriesNumber]: {...fields} }
 */
function loadMetadata() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function saveMetadata(all) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2));
}

/**
 * Gets one record's metadata by seriesNumber, or null if not present.
 */
function getMetadata(seriesNumber) {
  const all = loadMetadata();
  return all[seriesNumber] || null;
}

/**
 * Gets metadata for multiple seriesNumbers at once (used after a Milvus
 * search returns a list of matching IDs).
 */
function getMetadataBatch(seriesNumbers) {
  const all = loadMetadata();
  return seriesNumbers.map((sn) => ({ seriesNumber: sn, ...(all[sn] || {}) }));
}

/**
 * Inserts or overwrites one record's metadata.
 */
function upsertMetadata(record) {
  const all = loadMetadata();
  all[record.seriesNumber] = {
    scheduleNumber: record.scheduleNumber || '',
    seriesName: record.seriesName || '',
    description: record.description || '',
    retentionPeriod: record.retentionPeriod || '',
    dispositionMethod: record.dispositionMethod || '',
    textToEmbed: record.textToEmbed || ''
  };
  saveMetadata(all);
}

/**
 * Removes one record's metadata (kept in sync with Milvus deletes).
 */
function deleteMetadata(seriesNumber) {
  const all = loadMetadata();
  delete all[seriesNumber];
  saveMetadata(all);
}

module.exports = { loadMetadata, saveMetadata, getMetadata, getMetadataBatch, upsertMetadata, deleteMetadata };
