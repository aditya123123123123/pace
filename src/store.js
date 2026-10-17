// Tiny IndexedDB wrapper: documents stay on this device.
const DB = "pace";
let dbp;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("docs", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("docs", mode);
    const out = fn(t.objectStore("docs"));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
}

export async function saveDoc(doc) {
  const id = doc.id || (crypto.randomUUID?.() ?? String(Date.now() + Math.random()));
  const existing = doc.id ? await getDoc(doc.id) : null;
  const full = { pos: 0, ...existing, ...doc, id, opened: Date.now() };
  if (existing) full.pos = existing.pos;
  await tx("readwrite", (s) => s.put(full));
  return full;
}
export const getDoc = (id) => tx("readonly", (s) => s.get(id));
export async function deleteDoc(id) {
  await tx("readwrite", (s) => s.delete(id));
  await fileTx("readwrite", (s) => s.delete(id)).catch(() => {}); // the files DB may not exist yet
}
export async function listDocs() {
  const all = await tx("readonly", (s) => s.getAll());
  return (all || []).map(({ text, ...meta }) => meta).sort((a, b) => b.opened - a.opened);
}
export async function updatePos(id, pos) {
  return updateDoc(id, { pos });
}
/** Merge fields into a stored doc (also bumps it to the top of Recents). */
export async function updateDoc(id, fields) {
  const d = await getDoc(id);
  if (!d) return;
  Object.assign(d, fields, { opened: Date.now() });
  await tx("readwrite", (s) => s.put(d));
}

// ---------------------------------------------------------------- original PDFs
// Kept so the page navigator can show the real pages. A separate database: bumping
// "pace" to a new version would stall in any tab still running the old build.
let fdbp;
function fileDb() {
  fdbp ??= new Promise((res, rej) => {
    const r = indexedDB.open("pace-files", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("files");
    r.onsuccess = () => res(r.result);
    r.onerror = () => { fdbp = null; rej(r.error); };
  });
  return fdbp;
}
async function fileTx(mode, fn) {
  const d = await fileDb();
  return new Promise((res, rej) => {
    const t = d.transaction("files", mode);
    const out = fn(t.objectStore("files"));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
// Stored as an ArrayBuffer: WebKit aborts IndexedDB writes of File/Blob values in some contexts.
export const saveFile = async (id, file) => {
  const bytes = await file.arrayBuffer();
  return fileTx("readwrite", (s) => s.put(bytes, id));
};
/** @returns {Promise<ArrayBuffer | undefined>} */
export const getFile = (id) => fileTx("readonly", (s) => s.get(id));
