// store.js — keep the visitor's last own capture on the device.
//
// Camera shots and uploads live only in memory; a refresh used to erase a
// capture that might have taken minutes to walk. Every own set is therefore
// written into IndexedDB (blobs, origin-local, nothing leaves the machine)
// and offered back as a "Last capture" tile on the start card. One slot —
// each new capture replaces the previous one.

const DB = 'splatjs';
const STORE = 'captures';
const KEY = 'last';

function openDb() { return openDb2(); } // single opener — see openDb2 below

/** rec: { kind: 'photos'|'video', created, files: [{ name, blob }] } */
export async function saveLastCapture(rec) {
  const d = await openDb();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec, KEY);
    tx.oncomplete = () => { d.close(); res(); };
    tx.onerror = () => { d.close(); rej(tx.error); };
  });
}

export async function loadLastCapture() {
  try {
    const d = await openDb();
    return await new Promise((res, rej) => {
      const rq = d.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      rq.onsuccess = () => { d.close(); res(rq.result || null); };
      rq.onerror = () => { d.close(); rej(rq.error); };
    });
  } catch { return null; }
}

// ── local runs library ──────────────────────────────────────────────────────
// Every training run gets a record the moment it starts; finished runs keep
// their results (sog + recon + thumb) so closing the tab no longer discards
// an hour of GPU work. All of it stays in this origin's IndexedDB.

const RUNS = 'runs';
const KEEP = 12; // newest kept; oldest evicted beyond this

function openDb2() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      if (!d.objectStoreNames.contains(RUNS)) d.createObjectStore(RUNS, { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

const tx1 = (d, mode, fn) => new Promise((res, rej) => {
  const tx = d.transaction(RUNS, mode);
  const out = fn(tx.objectStore(RUNS));
  tx.oncomplete = () => { d.close(); res(out && out.result !== undefined ? out.result : undefined); };
  tx.onerror = () => { d.close(); rej(tx.error); };
});

/** rec: { id, name, status: 'training'|'finished', createdAt, updatedAt,
 *  iter, maxIters, splats, psnr, frames, thumb?: Blob, sog?: Blob,
 *  recon?: object } */
export async function saveRun(rec) {
  const d = await openDb2();
  await tx1(d, 'readwrite', (s) => s.put(rec));
  pruneRuns().catch(() => {});
}

export async function patchRun(id, patch) {
  try {
    const d = await openDb2();
    await new Promise((res, rej) => {
      const tx = d.transaction(RUNS, 'readwrite');
      const s = tx.objectStore(RUNS);
      const rq = s.get(id);
      rq.onsuccess = () => {
        if (rq.result) s.put({ ...rq.result, ...patch, updatedAt: Date.now() });
      };
      tx.oncomplete = () => { d.close(); res(); };
      tx.onerror = () => { d.close(); rej(tx.error); };
    });
  } catch { /* storage is best-effort — never disturb a run */ }
}

export async function listRuns() {
  try {
    const d = await openDb2();
    const all = await tx1(d, 'readonly', (s) => s.getAll());
    return (all || []).sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}

export async function deleteRun(id) {
  try {
    const d = await openDb2();
    await tx1(d, 'readwrite', (s) => s.delete(id));
  } catch { /* gone is gone */ }
}

async function pruneRuns() {
  const all = await listRuns();
  for (const r of all.slice(KEEP)) await deleteRun(r.id);
}

export async function deleteLastCapture() {
  try {
    const d = await openDb2();
    await new Promise((res, rej) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => { d.close(); res(); };
      tx.onerror = () => { d.close(); rej(tx.error); };
    });
  } catch { /* gone is gone */ }
}
