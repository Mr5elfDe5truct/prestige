// The render queue on disk: when the page reloads (Swap a character can fill the RAM until WebView2 restarts it), the
// renders that were waiting or running come back. IndexedDB, because a job can carry a picture or a voice recording
// (Blobs) and a few prepared workflows can be more than localStorage holds.
const DB = "prestige-queue";
const STORE = "jobs";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Replaces what's saved with these jobs (plain objects: no functions). */
export async function saveJobs(jobs: object[]) {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const s = tx.objectStore(STORE);
    s.clear();
    for (const j of jobs) s.put(j);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** The jobs saved last time, oldest first. */
export async function loadJobs<T>(): Promise<T[]> {
  const db = await open();
  const out = await new Promise<T[]>((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return out;
}
