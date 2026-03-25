/**
 * AudioStorage — IndexedDB wrapper for persisting audio files on the device.
 *
 * Audio files are stored locally so that:
 *  1. Poor internet during the event does not interrupt playback.
 *  2. Re-joining the same show does not require re-downloading.
 *  3. If the master uploads a new audio file (different hash), the stale
 *     cache is discarded and the new file is downloaded automatically.
 *
 * Storage key: `showId` (one record per show)
 */

const DB_NAME = 'cinewav-audio';
const DB_VERSION = 2;  // bumped to add hash field
const STORE_NAME = 'audio-files';

interface AudioRecord {
  showId: string;
  filename: string;
  hash: string;       // fingerprint for cache invalidation
  data: ArrayBuffer;
  storedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'showId' });
      }
      // No schema change needed — just adding a new field to existing records
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveAudio(
  showId: string,
  filename: string,
  data: ArrayBuffer,
  hash = '',
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record: AudioRecord = { showId, filename, hash, data, storedAt: Date.now() };
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function loadAudio(
  showId: string,
): Promise<{ filename: string; hash: string; data: ArrayBuffer } | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(showId);
    req.onsuccess = () => {
      const record = req.result as AudioRecord | undefined;
      if (record) {
        resolve({ filename: record.filename, hash: record.hash || '', data: record.data });
      } else {
        resolve(null);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function hasAudio(showId: string): Promise<boolean> {
  const result = await loadAudio(showId);
  return result !== null;
}

export async function deleteAudio(showId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(showId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
