// File inputs cannot survive an OAuth redirect. Keep guest-dropped files in IndexedDB so sign-in
// feels like one continuous action instead of making someone select the same footage twice.
const DB = "foltio-guest-upload";
const STORE = "files";

const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function stashGuestFiles(files: File[]) {
  if (!files.length || typeof indexedDB === "undefined") return 0;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.clear();
      files.forEach((file, id) => store.put({ id, file }));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return files.length;
  } finally {
    db.close();
  }
}

export async function readGuestFiles(): Promise<File[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDb();
  try {
    return await new Promise<File[]>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => a.id - b.id).map((x) => x.file).filter((x): x is File => x instanceof File));
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function clearGuestFiles() {
  if (typeof indexedDB === "undefined") return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally {
    db.close();
  }
}
