const DB_NAME = "redlineDB";
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("projects")) {
        db.createObjectStore("projects", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("chapters")) {
        const store = db.createObjectStore("chapters", { keyPath: "id" });
        store.createIndex("byProject", "projectId");
      }
      if (!db.objectStoreNames.contains("history")) {
        const store = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
        store.createIndex("byChapter", "chapterId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  // ---- projects ----
  async putProject(project) {
    const store = await tx("projects", "readwrite");
    await reqToPromise(store.put(project));
  },
  async getProject(id) {
    const store = await tx("projects", "readonly");
    return reqToPromise(store.get(id));
  },
  async getAllProjects() {
    const store = await tx("projects", "readonly");
    return reqToPromise(store.getAll());
  },
  async deleteProject(id) {
    const store = await tx("projects", "readwrite");
    await reqToPromise(store.delete(id));
  },

  // ---- chapters ----
  async putChapter(chapter) {
    const store = await tx("chapters", "readwrite");
    await reqToPromise(store.put(chapter));
  },
  async getChapter(id) {
    const store = await tx("chapters", "readonly");
    return reqToPromise(store.get(id));
  },
  async getChaptersForProject(projectId) {
    const store = await tx("chapters", "readonly");
    const idx = store.index("byProject");
    const all = await reqToPromise(idx.getAll(projectId));
    return all.sort((a, b) => a.order - b.order);
  },
  async deleteChapter(id) {
    const store = await tx("chapters", "readwrite");
    await reqToPromise(store.delete(id));
  },

  // ---- history (per-edit undo log) ----
  async addHistory(entry) {
    const store = await tx("history", "readwrite");
    return reqToPromise(store.add(entry));
  },
  async getHistoryForChapter(chapterId) {
    const store = await tx("history", "readonly");
    const idx = store.index("byChapter");
    const all = await reqToPromise(idx.getAll(chapterId));
    return all.sort((a, b) => b.timestamp - a.timestamp);
  },
  async deleteHistoryEntry(id) {
    const store = await tx("history", "readwrite");
    await reqToPromise(store.delete(id));
  },
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
