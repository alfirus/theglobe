const DB_NAME = 'globe-conversations';
const STORE_NAME = 'conversations';
const DB_VERSION = 1;

/**
 * Persisted conversation record (`content`, not the UI's `text` — see
 * `+page.svelte` for the mapping). Exported so components can import the real
 * shape instead of re-declaring an incompatible one.
 */
export interface Conversation {
  id: string;
  title: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string; ts?: number }>;
  provider: string;
  systemPrompt?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One shared connection for the whole app: opening a fresh database per call
 * (the previous version did it five times) leaks a connection per operation,
 * since IndexedDB connections are only released explicitly. The promise is
 * cached so every caller awaits the same instance, and it is torn down on
 * `versionchange`/`close`/page unload so a later call re-opens cleanly.
 */
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      // Another tab wants a newer schema — drop ours so it can upgrade.
      database.onversionchange = () => {
        database.close();
        dbPromise = null;
      };
      database.onclose = () => {
        dbPromise = null;
      };
      resolve(database);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

/** Close the shared connection (also wired to `pagehide` below). */
export function closeDB(): void {
  const pending = dbPromise;
  dbPromise = null;
  pending?.then((database) => database.close()).catch(() => {});
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => closeDB());
}

/**
 * Put a conversation. Does **not** mutate the caller's object: the record is
 * copied, `updatedAt` is stamped here and `createdAt` is preserved untouched
 * (the caller owns creation time; it must never be overwritten on re-save).
 */
export async function saveConversation(conversation: Conversation): Promise<Conversation> {
  const database = await openDB();
  const record: Conversation = {
    ...conversation,
    messages: conversation.messages.map((m) => ({ ...m })),
    createdAt: conversation.createdAt,
    updatedAt: Date.now()
  };

  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(record);
    request.onsuccess = () => resolve(record);
    request.onerror = () => reject(request.error);
  });
}

export async function getConversations(): Promise<Conversation[]> {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.updatedAt - a.updatedAt));
    request.onerror = () => reject(request.error);
  });
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteConversation(id: string): Promise<void> {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function clearAllConversations(): Promise<void> {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
