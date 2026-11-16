import type { PDFDocumentProxy } from 'pdfjs-dist';
import { BookMeta } from '../types/library';
import { getBookPdfBuffer } from './libraryDb';
import { createPdfLoadingTaskFromBuffer } from './pdfEngine';

interface CachedPdfEntry {
  doc: PDFDocumentProxy;
  cleanup: () => void;
}

const pdfDocCache = new Map<string, CachedPdfEntry>();
const pendingDocLoads = new Map<string, Promise<PDFDocumentProxy | null>>();

// LRU offscreen canvas cache for instant (<2ms) page opens and swipes
const MAX_CACHED_CANVASES = 32;
interface CachedPageBitmap {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
}
const renderedPageCache = new Map<string, CachedPageBitmap>();
const inflightPrewarms = new Set<string>();

export function computeSafeOutputScale(vw: number, vh: number): number {
  const desired = Math.max(2, Math.min(window.devicePixelRatio || 2, 3));
  const maxSide = Math.max(vw, vh);
  return maxSide * desired > 4096 ? Math.max(1, 4096 / maxSide) : desired;
}

export function getDefaultReaderFitWidth(): number {
  if (typeof document === 'undefined') return 390;
  const cw = document.documentElement.clientWidth || window.innerWidth || 390;
  return Math.max(260, Math.min(cw, 920));
}

export function getPageRenderCacheKey(
  bookId: string,
  pageNumber: number,
  scale: number,
  fitWidth: number
): string {
  return `${bookId}:${pageNumber}:${Math.round(scale * 100)}:${fitWidth}`;
}

export function getCachedRenderedPage(key: string): CachedPageBitmap | null {
  const entry = renderedPageCache.get(key);
  if (!entry) return null;
  // Refresh LRU order
  renderedPageCache.delete(key);
  renderedPageCache.set(key, entry);
  return entry;
}

export function setCachedRenderedPage(
  key: string,
  bitmap: CachedPageBitmap
): void {
  if (renderedPageCache.has(key)) {
    renderedPageCache.delete(key);
  }
  renderedPageCache.set(key, bitmap);
  if (renderedPageCache.size > MAX_CACHED_CANVASES) {
    const oldestKey = renderedPageCache.keys().next().value;
    if (oldestKey) {
      renderedPageCache.delete(oldestKey);
    }
  }
}

export function clearRenderedPagesForBook(bookId: string): void {
  for (const key of renderedPageCache.keys()) {
    if (key.startsWith(`${bookId}:`)) {
      renderedPageCache.delete(key);
    }
  }
}

export function getCachedPdfDoc(bookId: string): PDFDocumentProxy | null {
  return pdfDocCache.get(bookId)?.doc ?? null;
}

export async function ensureBookPdfLoaded(
  bookId: string,
  providedBuffer?: ArrayBuffer
): Promise<PDFDocumentProxy | null> {
  const existing = pdfDocCache.get(bookId);
  if (existing) return existing.doc;

  const inflight = pendingDocLoads.get(bookId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const buffer = providedBuffer ?? (await getBookPdfBuffer(bookId));
      if (!buffer) return null;
      const { loadingTask, cleanup } = createPdfLoadingTaskFromBuffer(buffer);
      const doc = await loadingTask.promise;
      // Warm PDF.js worker page-tree & default font tables immediately
      try {
        if (doc.numPages >= 1) {
          const p1 = await doc.getPage(1);
          p1.cleanup();
        }
      } catch {
        // Non-fatal warmup error
      }
      pdfDocCache.set(bookId, { doc, cleanup });
      return doc;
    } catch {
      return null;
    } finally {
      pendingDocLoads.delete(bookId);
    }
  })();

  pendingDocLoads.set(bookId, promise);
  return promise;
}

export async function preloadAllBookPdfs(
  books: BookMeta[],
  onBookLoaded?: (loadedCount: number, totalCount: number) => void
): Promise<void> {
  let done = 0;
  const total = books.length;
  await Promise.all(
    books.map(async (b) => {
      await ensureBookPdfLoaded(b.id);
      await getBookCoverDataUrl(b.id);
      done++;
      onBookLoaded?.(done, total);
    })
  );
}

/**
 * Silently pre-renders target pages at full native HiDPI quality in the background
 * so tapping a chapter or search result opens immediately from the canvas cache.
 */
export function prewarmBookPages(
  bookId: string,
  pageNumbers: number[],
  fitWidth = getDefaultReaderFitWidth()
): () => void {
  let cancelled = false;
  const uniquePages = Array.from(new Set(pageNumbers)).filter((p) => p >= 1);
  if (uniquePages.length === 0) return () => {};

  const run = async () => {
    const doc = getCachedPdfDoc(bookId) ?? (await ensureBookPdfLoaded(bookId));
    if (!doc || cancelled) return;

    for (const pageNum of uniquePages) {
      if (cancelled || pageNum > doc.numPages) break;
      const key = getPageRenderCacheKey(bookId, pageNum, 1, fitWidth);
      if (getCachedRenderedPage(key) || inflightPrewarms.has(key)) continue;

      inflightPrewarms.add(key);
      try {
        const page = await doc.getPage(pageNum);
        if (cancelled) break;
        const base = page.getViewport({ scale: 1 });
        const fitScale = fitWidth / base.width;
        const viewport = page.getViewport({ scale: fitScale });
        const outputScale = computeSafeOutputScale(viewport.width, viewport.height);

        const offscreen = document.createElement('canvas');
        offscreen.width = Math.floor(viewport.width * outputScale);
        offscreen.height = Math.floor(viewport.height * outputScale);
        const ctx = offscreen.getContext('2d');
        if (ctx) {
          const transform =
            outputScale !== 1
              ? [outputScale, 0, 0, outputScale, 0, 0]
              : undefined;
          await page.render({
            canvas: offscreen,
            canvasContext: ctx,
            transform,
            viewport,
          }).promise;

          if (!cancelled) {
            setCachedRenderedPage(key, {
              canvas: offscreen,
              width: offscreen.width,
              height: offscreen.height,
              cssWidth: Math.floor(viewport.width),
              cssHeight: Math.floor(viewport.height),
            });
          }
        }
        page.cleanup();
      } catch {
        // Ignore cancelled/background errors
      } finally {
        inflightPrewarms.delete(key);
      }

      // Yield to main thread between pages so scrolling/taps remain instantaneous
      await new Promise((r) => window.setTimeout(r, 15));
    }
  };

  const timer = window.setTimeout(() => {
    void run();
  }, 40);

  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}

const bookCoverCache = new Map<string, string>();
const pendingCoverLoads = new Map<string, Promise<string | null>>();

export function getCachedBookCover(bookId: string): string | null {
  return bookCoverCache.get(bookId) ?? null;
}

export async function getBookCoverDataUrl(
  bookId: string
): Promise<string | null> {
  const cached = bookCoverCache.get(bookId);
  if (cached) return cached;

  const inflight = pendingCoverLoads.get(bookId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const doc = getCachedPdfDoc(bookId) ?? (await ensureBookPdfLoaded(bookId));
      if (!doc || doc.numPages < 1) return null;

      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const targetWidth = 128; // crisp 3x retina thumbnail for ~42px CSS box
      const viewport = page.getViewport({ scale: targetWidth / base.width });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        page.cleanup();
        return null;
      }

      await page.render({
        canvas,
        canvasContext: ctx,
        viewport,
      }).promise;
      page.cleanup();

      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      bookCoverCache.set(bookId, dataUrl);
      return dataUrl;
    } catch {
      return null;
    } finally {
      pendingCoverLoads.delete(bookId);
    }
  })();

  pendingCoverLoads.set(bookId, promise);
  return promise;
}

export function unloadBookPdf(bookId: string): void {
  clearRenderedPagesForBook(bookId);
  bookCoverCache.delete(bookId);
  const entry = pdfDocCache.get(bookId);
  if (entry) {
    entry.cleanup();
    pdfDocCache.delete(bookId);
  }
}
