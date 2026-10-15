// Persists the recording to IndexedDB chunk by chunk while it is being made.
// iOS Safari reloads the tab when it runs out of memory, which used to throw away a finished
// video; with this, the last recording survives a reload and the page can offer it again.
// Blobs read back from IndexedDB are disk-backed, so they also keep memory use low.

const DB_NAME = 'trail-reel';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('recordings', { keyPath: 'id' });
      db.createObjectStore('chunks', { keyPath: ['rec', 'idx'] }).createIndex('rec', 'rec');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const result = fn(t);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqValue = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Only one recording is kept: starting a new one deletes the previous one. */
export async function beginRecording({ name, type }) {
  const db = await openDb();
  await clearRecordings();
  const rec = { id: Date.now(), name, type, status: 'recording', size: 0, chunks: 0, started: Date.now() };
  await tx(db, ['recordings'], 'readwrite', (t) => t.objectStore('recordings').put(rec));
  return rec;
}

export async function appendChunk(rec, blob) {
  const db = await openDb();
  const idx = rec.chunks++;
  rec.size += blob.size;
  await tx(db, ['chunks', 'recordings'], 'readwrite', (t) => {
    t.objectStore('chunks').put({ rec: rec.id, idx, blob });
    t.objectStore('recordings').put({ ...rec });
  });
}

export async function finishRecording(rec) {
  const db = await openDb();
  rec.status = 'done';
  await tx(db, ['recordings'], 'readwrite', (t) => t.objectStore('recordings').put({ ...rec }));
}

/** The stored recording as one Blob (assembled from disk-backed chunks), or null. */
export async function loadRecordingBlob(rec) {
  const db = await openDb();
  const t = db.transaction(['chunks'], 'readonly');
  const rows = await reqValue(t.objectStore('chunks').index('rec').getAll(IDBKeyRange.only(rec.id)));
  if (!rows.length) return null;
  rows.sort((a, b) => a.idx - b.idx);
  return new Blob(
    rows.map((r) => r.blob),
    { type: rec.type }
  );
}

export async function latestRecording() {
  const db = await openDb();
  const all = await reqValue(db.transaction(['recordings'], 'readonly').objectStore('recordings').getAll());
  return all.sort((a, b) => b.id - a.id)[0] || null;
}

export async function clearRecordings() {
  const db = await openDb();
  await tx(db, ['recordings', 'chunks'], 'readwrite', (t) => {
    t.objectStore('recordings').clear();
    t.objectStore('chunks').clear();
  });
}
