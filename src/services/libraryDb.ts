import { BookMeta, PageTextEntry } from '../types/library';

const DB_NAME = 'offline-medical-pdf-library-v1';
const DB_VERSION = 1;

const STORE_BOOKS = 'books';
const STORE_PDFS = 'pdfs';
const STORE_PAGES = 'pages';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PDFS)) {
        db.createObjectStore(STORE_PDFS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PAGES)) {
        const pageStore = db.createObjectStore(STORE_PAGES, { keyPath: 'key' });
        pageStore.createIndex('bookId', 'bookId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

export async function getAllBooks(): Promise<BookMeta[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readonly');
    const req = tx.objectStore(STORE_BOOKS).getAll();
    req.onsuccess = () => {
      const books = (req.result as BookMeta[]).sort((a, b) => b.addedAt - a.addedAt);
      resolve(books);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveBookToDb(
  meta: BookMeta,
  pdfBuffer: ArrayBuffer,
  pages: PageTextEntry[]
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_BOOKS, STORE_PDFS, STORE_PAGES], 'readwrite');
    tx.objectStore(STORE_BOOKS).put(meta);
    tx.objectStore(STORE_PDFS).put({ id: meta.id, data: pdfBuffer });
    const pageStore = tx.objectStore(STORE_PAGES);
    for (const p of pages) {
      pageStore.put(p);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function updateBookTitleInDb(
  bookId: string,
  newTitle: string
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readwrite');
    const store = tx.objectStore(STORE_BOOKS);
    const req = store.get(bookId);
    req.onsuccess = () => {
      const existing = req.result as BookMeta | undefined;
      if (existing) {
        store.put({ ...existing, title: newTitle });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getBookPdfBuffer(bookId: string): Promise<ArrayBuffer | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PDFS, 'readonly');
    const req = tx.objectStore(STORE_PDFS).get(bookId);
    req.onsuccess = () => {
      const record = req.result as { id: string; data: ArrayBuffer } | undefined;
      resolve(record?.data ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getBookPages(bookId: string): Promise<PageTextEntry[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PAGES, 'readonly');
    const idx = tx.objectStore(STORE_PAGES).index('bookId');
    const req = idx.getAll(IDBKeyRange.only(bookId));
    req.onsuccess = () => {
      const pages = (req.result as PageTextEntry[]).sort(
        (a, b) => a.pageNumber - b.pageNumber
      );
      resolve(pages);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getAllIndexedPages(): Promise<PageTextEntry[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PAGES, 'readonly');
    const req = tx.objectStore(STORE_PAGES).getAll();
    req.onsuccess = () => resolve(req.result as PageTextEntry[]);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteBookFromDb(bookId: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_BOOKS, STORE_PDFS, STORE_PAGES], 'readwrite');
    tx.objectStore(STORE_BOOKS).delete(bookId);
    tx.objectStore(STORE_PDFS).delete(bookId);
    const pageStore = tx.objectStore(STORE_PAGES);
    const idx = pageStore.index('bookId');
    const cursorReq = idx.openKeyCursor(IDBKeyRange.only(bookId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        pageStore.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
