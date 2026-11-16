import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { TextLayer, setLayerDimensions } from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import {
  BookMeta,
  ChapterHeading,
  PageTextEntry,
} from '../types/library';
import {
  computeSafeOutputScale,
  ensureBookPdfLoaded,
  getCachedPdfDoc,
  getCachedRenderedPage,
  getDefaultReaderFitWidth,
  getPageRenderCacheKey,
  setCachedRenderedPage,
} from '../services/pdfCache';
import {
  normalizeForSearch,
  toPersianDigits,
} from '../utils/arabicNormalize';

interface PdfChapterReaderProps {
  book: BookMeta;
  chapter: ChapterHeading;
  bookPages: PageTextEntry[];
  initialSearchQuery?: string;
  initialPageNumber?: number;
  onBackToChapters: () => void;
}

interface SinglePdfPageProps {
  bookId: string;
  pdf: PDFDocumentProxy;
  pageNumber: number;
  totalPages: number;
  scale: number;
  searchQuery: string;
  activeMatchOnThisPage: number | null;
  viewportWidth: number;
}

const SinglePdfPage: React.FC<SinglePdfPageProps> = ({
  bookId,
  pdf,
  pageNumber,
  totalPages,
  scale,
  searchQuery,
  activeMatchOnThisPage,
  viewportWidth,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);

  const fitWidth = viewportWidth;

  const [pageSize, setPageSize] = useState<{
    width: number;
    height: number;
    viewportScale: number;
  }>({
    width: fitWidth,
    height: Math.round(fitWidth * 1.414),
    viewportScale: 1,
  });

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayerInstance: TextLayer | null = null;
    let idleTimer: number | null = null;
    let textRafId: number | null = null;

    const cacheKey = getPageRenderCacheKey(bookId, pageNumber, scale, fitWidth);
    const cachedImmediate = getCachedRenderedPage(cacheKey);
    if (cachedImmediate && canvasRef.current) {
      const c = canvasRef.current;
      c.width = cachedImmediate.width;
      c.height = cachedImmediate.height;
      c.style.width = `${cachedImmediate.cssWidth}px`;
      c.style.height = `${cachedImmediate.cssHeight}px`;
      const cCtx = c.getContext('2d');
      if (cCtx) {
        cCtx.drawImage(cachedImmediate.canvas, 0, 0);
      }
      setPageSize((prev) =>
        prev.width === cachedImmediate.cssWidth &&
        prev.height === cachedImmediate.cssHeight
          ? prev
          : {
              ...prev,
              width: cachedImmediate.cssWidth,
              height: cachedImmediate.cssHeight,
            }
      );
    }

    const scheduleNeighborsPrewarm = () => {
      idleTimer = window.setTimeout(async () => {
        if (cancelled) return;
        const neighbors = [pageNumber + 1, pageNumber - 1].filter(
          (p) => p >= 1 && p <= totalPages
        );
        for (const nPageNum of neighbors) {
          if (cancelled) break;
          const nKey = getPageRenderCacheKey(bookId, nPageNum, scale, fitWidth);
          if (getCachedRenderedPage(nKey)) continue;
          try {
            const nPage = await pdf.getPage(nPageNum);
            if (cancelled) break;
            const nBase = nPage.getViewport({ scale: 1 });
            const nFitScale = fitWidth / nBase.width;
            const nViewport = nPage.getViewport({ scale: nFitScale * scale });
            const nOutputScale = computeSafeOutputScale(
              nViewport.width,
              nViewport.height
            );
            const offscreen = document.createElement('canvas');
            offscreen.width = Math.floor(nViewport.width * nOutputScale);
            offscreen.height = Math.floor(nViewport.height * nOutputScale);
            const offCtx = offscreen.getContext('2d');
            if (!offCtx) continue;
            const nTransform =
              nOutputScale !== 1
                ? [nOutputScale, 0, 0, nOutputScale, 0, 0]
                : undefined;
            await nPage.render({
              canvas: offscreen,
              canvasContext: offCtx,
              transform: nTransform,
              viewport: nViewport,
            }).promise;
            if (!cancelled) {
              setCachedRenderedPage(nKey, {
                canvas: offscreen,
                width: offscreen.width,
                height: offscreen.height,
                cssWidth: Math.floor(nViewport.width),
                cssHeight: Math.floor(nViewport.height),
              });
            }
            nPage.cleanup();
          } catch {
            // Ignore background pre-render errors
          }
        }
      }, 10);
    };

    const renderPageAndPrewarm = async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const fitScale = fitWidth / baseViewport.width;
        const effectiveScale = fitScale * scale;
        const viewport = page.getViewport({ scale: effectiveScale });

        const targetW = Math.floor(viewport.width);
        const targetH = Math.floor(viewport.height);

        if (!cancelled) {
          setPageSize({
            width: targetW,
            height: targetH,
            viewportScale: viewport.scale,
          });
        }

        const canvas = canvasRef.current;
        const textLayerEl = textLayerRef.current;
        if (!canvas || !textLayerEl) return;

        // Full native HiDPI sharpness (2x-3x), safely capped at 4096px max side only on extreme zoom
        const outputScale = computeSafeOutputScale(viewport.width, viewport.height);
        const cached = getCachedRenderedPage(cacheKey);
        const expectedW = Math.floor(viewport.width * outputScale);
        const expectedH = Math.floor(viewport.height * outputScale);

        if (
          !cached ||
          cached.width !== expectedW ||
          cached.height !== expectedH
        ) {
          canvas.width = expectedW;
          canvas.height = expectedH;
          canvas.style.width = `${targetW}px`;
          canvas.style.height = `${targetH}px`;

          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          const transform =
            outputScale !== 1
              ? [outputScale, 0, 0, outputScale, 0, 0]
              : undefined;

          renderTask = page.render({
            canvas,
            canvasContext: ctx,
            transform,
            viewport,
          });
          await renderTask.promise;
          if (cancelled) return;

          const offscreen = document.createElement('canvas');
          offscreen.width = canvas.width;
          offscreen.height = canvas.height;
          const offCtx = offscreen.getContext('2d');
          if (offCtx) {
            offCtx.drawImage(canvas, 0, 0);
            setCachedRenderedPage(cacheKey, {
              canvas: offscreen,
              width: canvas.width,
              height: canvas.height,
              cssWidth: targetW,
              cssHeight: targetH,
            });
          }
        }

        if (cancelled) return;

        // Start pre-rendering adjacent pages (+1, -1) immediately after canvas paint
        scheduleNeighborsPrewarm();

        const buildTextLayer = async () => {
          if (cancelled) return;
          textLayerEl.innerHTML = '';
          textLayerEl.style.setProperty('--scale-factor', String(viewport.scale));
          textLayerEl.style.setProperty('--total-scale-factor', String(viewport.scale));
          textLayerEl.style.setProperty('--scale-round-x', '1px');
          textLayerEl.style.setProperty('--scale-round-y', '1px');
          setLayerDimensions(textLayerEl, viewport);

          const textContent = await page.getTextContent();
          if (cancelled) return;

          textLayerInstance = new TextLayer({
            textContentSource: textContent,
            container: textLayerEl,
            viewport,
          });
          await textLayerInstance.render();
          if (cancelled) return;

          const cleanQ = normalizeForSearch(searchQuery).trim();
          if (cleanQ.length >= 2) {
            let hitCounter = 0;
            const spans = textLayerEl.querySelectorAll('span');
            spans.forEach((span) => {
              const txt = span.textContent || '';
              const normTxt = normalizeForSearch(txt);
              if (!normTxt || !normTxt.includes(cleanQ)) return;
              const isTarget =
                activeMatchOnThisPage !== null &&
                hitCounter === activeMatchOnThisPage;
              span.classList.add(isTarget ? 'pdf-hit-active' : 'pdf-hit');
              hitCounter++;
            });
          }
        };

        if (normalizeForSearch(searchQuery).trim().length >= 2) {
          await buildTextLayer();
        } else {
          textRafId = window.requestAnimationFrame(() => {
            void buildTextLayer();
          });
        }
      } catch {
        // Ignore cancelled render tasks
      }
    };

    void renderPageAndPrewarm();

    return () => {
      cancelled = true;
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      if (textRafId !== null) window.cancelAnimationFrame(textRafId);
      renderTask?.cancel();
      textLayerInstance?.cancel();
    };
  }, [
    bookId,
    pdf,
    pageNumber,
    totalPages,
    scale,
    fitWidth,
    searchQuery,
    activeMatchOnThisPage,
  ]);

  return (
    <div
      id={`pdf-page-${pageNumber}`}
      dir="ltr"
      className="pdf-page-shell relative mx-auto overflow-hidden bg-white shadow-sm"
      style={{
        width: `${pageSize.width}px`,
        height: `${pageSize.height}px`,
        ['--scale-factor' as string]: String(pageSize.viewportScale),
        ['--total-scale-factor' as string]: String(pageSize.viewportScale),
      }}
    >
      <canvas ref={canvasRef} className="block" />
      <div ref={textLayerRef} className="textLayer" />
    </div>
  );
};

export const PdfChapterReader: React.FC<PdfChapterReaderProps> = ({
  book,
  chapter,
  bookPages,
  initialSearchQuery = '',
  initialPageNumber,
  onBackToChapters,
}) => {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(() =>
    getCachedPdfDoc(book.id)
  );
  const [pdfLoadError, setPdfLoadError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<number>(
    initialPageNumber ?? chapter.startPage
  );
  const [zoomScale, setZoomScale] = useState<number>(1);
  const [livePinchRatio, setLivePinchRatio] = useState<number>(1);
  const [swipeOffsetX, setSwipeOffsetX] = useState<number>(0);

  const activeSearchQuery = initialSearchQuery.trim();
  const [activeMatchIdx, setActiveMatchIdx] = useState<number>(0);
  const [showScrollTop, setShowScrollTop] = useState<boolean>(false);
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    getDefaultReaderFitWidth()
  );

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<{
    mode: 'none' | 'pinch' | 'swipe';
    startDist: number;
    startScale: number;
    startX: number;
    startY: number;
    lockedAxis: 'none' | 'x' | 'y';
  }>({
    mode: 'none',
    startDist: 0,
    startScale: 1,
    startX: 0,
    startY: 0,
    lockedAxis: 'none',
  });

  useEffect(() => {
    setCurrentPage(initialPageNumber ?? chapter.startPage);
    scrollContainerRef.current?.scrollTo({ top: 0, left: 0 });
  }, [chapter.id, chapter.startPage, initialPageNumber]);

  useEffect(() => {
    const cached = getCachedPdfDoc(book.id);
    if (cached) {
      setPdfDoc(cached);
      setPdfLoadError(null);
      return;
    }
    let active = true;
    setPdfLoadError(null);
    void ensureBookPdfLoaded(book.id).then((doc) => {
      if (!active) return;
      if (doc) {
        setPdfDoc(doc);
      } else {
        setPdfLoadError('خطا در بارگذاری فایل PDF از حافظه دستگاه.');
      }
    });
    return () => {
      active = false;
    };
  }, [book.id]);

  useEffect(() => {
    const updateWidth = () => {
      const next = getDefaultReaderFitWidth();
      setViewportWidth((prev) => (Math.abs(next - prev) > 4 ? next : prev));
    };
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const handleScroll = () => {
      setShowScrollTop(el.scrollTop > 120);
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // Fast O(N) scan using pre-normalized index (sub-1ms even across 2,500+ pages)
  const bookMatches = useMemo(() => {
    const normQ = normalizeForSearch(activeSearchQuery);
    if (normQ.length < 2) return [];
    const results: Array<{ pageNumber: number; matchIndexOnPage: number }> = [];
    const step = Math.max(1, normQ.length);
    for (let i = 0; i < bookPages.length; i++) {
      const pg = bookPages[i];
      if (!pg.normalizedText.includes(normQ)) continue;
      let pos = 0;
      let matchIdx = 0;
      while ((pos = pg.normalizedText.indexOf(normQ, pos)) !== -1) {
        results.push({ pageNumber: pg.pageNumber, matchIndexOnPage: matchIdx });
        matchIdx++;
        pos += step;
      }
    }
    return results;
  }, [bookPages, activeSearchQuery]);

  useEffect(() => {
    if (bookMatches.length === 0) {
      setActiveMatchIdx(0);
      return;
    }
    const targetPage = initialPageNumber ?? chapter.startPage;
    const foundIdx = bookMatches.findIndex((m) => m.pageNumber === targetPage);
    setActiveMatchIdx(foundIdx >= 0 ? foundIdx : 0);
  }, [bookMatches, initialPageNumber, chapter.startPage]);

  const goToPage = useCallback(
    (targetPage: number) => {
      const bounded = Math.max(1, Math.min(book.pageCount, targetPage));
      setCurrentPage(bounded);
      scrollContainerRef.current?.scrollTo({ top: 0, left: 0 });
    },
    [book.pageCount]
  );

  const jumpToMatch = useCallback(
    (nextIndex: number) => {
      if (bookMatches.length === 0) return;
      const wrapped = (nextIndex + bookMatches.length) % bookMatches.length;
      setActiveMatchIdx(wrapped);
      goToPage(bookMatches[wrapped].pageNumber);
    },
    [bookMatches, goToPage]
  );

  // Two-finger pinch-to-zoom (min 100%) + 1-finger horizontal swipe (never blocks vertical scroll)
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      gestureRef.current = {
        mode: 'pinch',
        startDist: Math.hypot(dx, dy),
        startScale: zoomScale,
        startX: 0,
        startY: 0,
        lockedAxis: 'none',
      };
      setSwipeOffsetX(0);
    } else if (e.touches.length === 1) {
      // Allow page slide ONLY when fully zoomed out to 100%
      if (zoomScale <= 1.01) {
        gestureRef.current = {
          mode: 'swipe',
          startDist: 0,
          startScale: zoomScale,
          startX: e.touches[0].clientX,
          startY: e.touches[0].clientY,
          lockedAxis: 'none',
        };
      } else {
        gestureRef.current.mode = 'none';
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && gestureRef.current.mode === 'pinch') {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      if (gestureRef.current.startDist <= 0) return;

      const ratio = dist / gestureRef.current.startDist;
      const clampedTarget = Math.min(
        3.5,
        Math.max(1.0, gestureRef.current.startScale * ratio)
      );
      setLivePinchRatio(clampedTarget / zoomScale);
    } else if (
      e.touches.length === 1 &&
      gestureRef.current.mode === 'swipe' &&
      zoomScale <= 1.01
    ) {
      const dx = e.touches[0].clientX - gestureRef.current.startX;
      const dy = e.touches[0].clientY - gestureRef.current.startY;

      if (gestureRef.current.lockedAxis === 'none') {
        if (Math.abs(dx) > 16 || Math.abs(dy) > 16) {
          gestureRef.current.lockedAxis =
            Math.abs(dx) > Math.abs(dy) * 1.6 ? 'x' : 'y';
        }
      }

      if (gestureRef.current.lockedAxis === 'x') {
        setSwipeOffsetX(Math.max(-110, Math.min(110, dx * 0.55)));
      }
    }
  };

  const handleTouchEnd = () => {
    if (gestureRef.current.mode === 'pinch') {
      if (Math.abs(livePinchRatio - 1) > 0.02) {
        const rawScale = Math.min(3.5, Math.max(1.0, zoomScale * livePinchRatio));
        // Snap cleanly to 1.0 (100%) when zooming back out close to 100%
        const nextScale = rawScale <= 1.04 ? 1 : Number(rawScale.toFixed(2));
        setZoomScale(nextScale);
      }
      setLivePinchRatio(1);
    } else if (
      gestureRef.current.mode === 'swipe' &&
      gestureRef.current.lockedAxis === 'x' &&
      zoomScale <= 1.01
    ) {
      if (swipeOffsetX <= -34 && currentPage < book.pageCount) {
        goToPage(currentPage + 1);
      } else if (swipeOffsetX >= 34 && currentPage > 1) {
        goToPage(currentPage - 1);
      }
      setSwipeOffsetX(0);
    } else {
      setSwipeOffsetX(0);
    }
    gestureRef.current.mode = 'none';
    gestureRef.current.lockedAxis = 'none';
  };

  const activeMatch = bookMatches[activeMatchIdx] ?? null;
  const isAtMinZoom = zoomScale <= 1.01;

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-x-clip bg-slate-100">
      {/* Top Header: Larger Back Button (top-right in RTL) + Very Tiny Centered Page Number */}
      <div className="relative z-20 flex h-14 shrink-0 items-center border-b border-slate-200 bg-white px-3 sm:px-5">
        <button
          type="button"
          onClick={onBackToChapters}
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 transition-colors hover:bg-slate-50 active:bg-slate-100 shrink-0"
          aria-label="بازگشت"
        >
          <ArrowRight className="h-5 w-5" />
        </button>

        <div className="pointer-events-none absolute inset-x-0 text-center text-[10px] leading-none font-medium text-slate-400 tabular-nums">
          {toPersianDigits(currentPage)} / {toPersianDigits(book.pageCount)}
        </div>
      </div>

      {/* Vertically Scrollable + Vertically Centered + Horizontally Swipeable + Two-Finger Pinchable PDF Page */}
      <div
        ref={scrollContainerRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className={`relative min-h-0 flex-1 overflow-y-auto ${
          isAtMinZoom ? 'overflow-x-hidden' : 'overflow-x-auto'
        }`}
        style={{
          touchAction: isAtMinZoom ? 'pan-y' : 'pan-x pan-y',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {pdfLoadError ? (
          <div className="mx-4 mt-4 rounded-2xl border border-rose-200 bg-white p-6 text-center text-sm text-rose-700">
            {pdfLoadError}
          </div>
        ) : !pdfDoc ? (
          <div className="flex min-h-full items-center justify-center">
            <div className="h-[540px] w-full max-w-2xl animate-pulse bg-white" />
          </div>
        ) : (
          <div
            dir="ltr"
            className="mx-auto flex min-h-full w-fit min-w-full flex-col origin-top-left transition-transform duration-75"
            style={{
              transform: [
                swipeOffsetX !== 0 ? `translateX(${swipeOffsetX}px)` : '',
                livePinchRatio !== 1 ? `scale(${livePinchRatio})` : '',
              ]
                .filter(Boolean)
                .join(' ') || undefined,
            }}
          >
            <div className="my-auto">
              <SinglePdfPage
                bookId={book.id}
                pdf={pdfDoc}
                pageNumber={currentPage}
                totalPages={book.pageCount}
                scale={zoomScale}
                searchQuery={activeSearchQuery}
                activeMatchOnThisPage={
                  activeMatch?.pageNumber === currentPage
                    ? activeMatch.matchIndexOnPage
                    : null
                }
                viewportWidth={viewportWidth}
              />
            </div>
          </div>
        )}
      </div>

      {/* Bottom-Right Floating Controls Over Image: Scroll-to-top + Search Up/Down */}
      {(showScrollTop || (activeSearchQuery.length >= 2 && bookMatches.length > 0)) && (
        <div className="fixed bottom-4 right-4 z-30 flex flex-col items-center gap-2">
          {showScrollTop && (
            <button
              type="button"
              onClick={() =>
                scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
              }
              aria-label="بازگشت به بالای صفحه"
              className="flex h-11 w-11 items-center justify-center rounded-full bg-teal-700 text-white shadow-lg transition-transform hover:bg-teal-800 active:scale-95"
            >
              <ArrowUp className="h-5 w-5" />
            </button>
          )}

          {activeSearchQuery.length >= 2 && bookMatches.length > 0 && (
            <div className="flex flex-col items-center gap-1 rounded-2xl border border-slate-200/90 bg-white/95 p-1 shadow-lg backdrop-blur-sm">
              <button
                type="button"
                onClick={() => jumpToMatch(activeMatchIdx - 1)}
                aria-label="نتیجه قبلی"
                className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100 active:bg-slate-200"
              >
                <ChevronUp className="h-5 w-5" />
              </button>
              <span className="text-[10px] font-semibold text-slate-500 tabular-nums leading-none">
                {toPersianDigits(activeMatchIdx + 1)}/{toPersianDigits(bookMatches.length)}
              </span>
              <button
                type="button"
                onClick={() => jumpToMatch(activeMatchIdx + 1)}
                aria-label="نتیجه بعدی"
                className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100 active:bg-slate-200"
              >
                <ChevronDown className="h-5 w-5" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
