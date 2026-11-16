import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import {
  AppTab,
  BookMeta,
  ChapterHeading,
  PageTextEntry,
} from './types/library';
import {
  deleteBookFromDb,
  getAllBooks,
  getAllIndexedPages,
  getBookPages,
  saveBookToDb,
  updateBookTitleInDb,
} from './services/libraryDb';
import {
  extractAndIndexPdf,
  findChapterInTree,
  normalizeChaptersTree,
} from './services/pdfEngine';
import {
  ensureBookPdfLoaded,
  preloadAllBookPdfs,
  unloadBookPdf,
} from './services/pdfCache';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { PWAInstallButton } from './components/PWAInstallButton';
import { BottomTabBar } from './components/BottomTabBar';
import { LibraryBooksView } from './components/LibraryBooksView';
import { BookChaptersView } from './components/BookChaptersView';
import { PdfChapterReader } from './components/PdfChapterReader';
import { GlobalSearchView } from './components/GlobalSearchView';

type LibraryViewState =
  | { kind: 'books' }
  | { kind: 'chapters'; book: BookMeta }
  | {
      kind: 'reader';
      book: BookMeta;
      chapter: ChapterHeading;
      initialSearchQuery?: string;
      initialPageNumber?: number;
    };

interface SearchReaderState {
  book: BookMeta;
  chapter: ChapterHeading;
  initialSearchQuery: string;
  initialPageNumber: number;
}

export default function App() {
  const isOnline = useOnlineStatus();
  const [activeTab, setActiveTab] = useState<AppTab>('library');
  const [libraryView, setLibraryView] = useState<LibraryViewState>({
    kind: 'books',
  });
  const [searchReader, setSearchReader] = useState<SearchReaderState | null>(
    null
  );

  const [books, setBooks] = useState<BookMeta[]>([]);
  const [allPages, setAllPages] = useState<PageTextEntry[]>([]);
  const [pagesLoaded, setPagesLoaded] = useState(false);
  const [isLoadingPages, setIsLoadingPages] = useState(false);
  const [activeBookPages, setActiveBookPages] = useState<PageTextEntry[]>([]);

  // Initial startup overlay: capped briefly so app appears smoothly with zero white flash
  const [startupLoading, setStartupLoading] = useState(true);
  const [splashRemoved, setSplashRemoved] = useState(false);

  const pagesLoadPromiseRef = useRef<Promise<PageTextEntry[]> | null>(null);

  const [indexingProgress, setIndexingProgress] = useState<{
    active: boolean;
    percent: number;
    label: string;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const pagesByBookId = useMemo(() => {
    const map = new Map<string, PageTextEntry[]>();
    for (let i = 0; i < allPages.length; i++) {
      const p = allPages[i];
      let arr = map.get(p.bookId);
      if (!arr) {
        arr = [];
        map.set(p.bookId, arr);
      }
      arr.push(p);
    }
    return map;
  }, [allPages]);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const loadedBooks = await getAllBooks();
        if (!active) return;
        setBooks(loadedBooks);

        // Start full page index & PDF worker warmup in parallel
        let pagesReady = false;
        let booksLoadedCount = 0;
        const targetBookCount = Math.ceil(loadedBooks.length * 0.8);

        let resolveThreshold!: () => void;
        const thresholdPromise = new Promise<void>((resolve) => {
          resolveThreshold = resolve;
        });

        const checkThreshold = () => {
          if (pagesReady && booksLoadedCount >= targetBookCount) {
            resolveThreshold();
          }
        };

        const pagesPromise = getAllIndexedPages().then((loadedPages) => {
          if (active) {
            setAllPages(loadedPages);
            setPagesLoaded(true);
          }
          pagesReady = true;
          checkThreshold();
          return loadedPages;
        });
        pagesLoadPromiseRef.current = pagesPromise;

        if (loadedBooks.length > 0) {
          void preloadAllBookPdfs(loadedBooks, (done) => {
            booksLoadedCount = done;
            checkThreshold();
          });

          // Wait until ~80% of books + search index are loaded (safety cap 4.5s)
          await Promise.race([
            thresholdPromise,
            new Promise<void>((resolve) => window.setTimeout(resolve, 4500)),
          ]);
        } else {
          await pagesPromise;
        }
      } catch {
        if (active) {
          setErrorMessage('خطا در خواندن اطلاعات کتابخانه از حافظه دستگاه.');
        }
      } finally {
        if (active) {
          setStartupLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (startupLoading || splashRemoved) return;
    const timer = window.setTimeout(() => setSplashRemoved(true), 220);
    return () => window.clearTimeout(timer);
  }, [startupLoading, splashRemoved]);

  const ensureAllPagesLoaded = useCallback(async (): Promise<PageTextEntry[]> => {
    if (pagesLoaded) return allPages;
    if (pagesLoadPromiseRef.current) {
      setIsLoadingPages(true);
      try {
        return await pagesLoadPromiseRef.current;
      } finally {
        setIsLoadingPages(false);
      }
    }
    setIsLoadingPages(true);
    try {
      const p = getAllIndexedPages();
      pagesLoadPromiseRef.current = p;
      const loaded = await p;
      setAllPages(loaded);
      setPagesLoaded(true);
      return loaded;
    } finally {
      setIsLoadingPages(false);
    }
  }, [allPages, pagesLoaded]);

  const handleImportFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter(
      (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    );

    if (files.length === 0) {
      setErrorMessage('لطفاً فقط فایل با فرمت PDF انتخاب کنید.');
      return;
    }

    setErrorMessage(null);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        setIndexingProgress({
          active: true,
          percent: 5,
          label: `فایل ${file.name}...`,
        });

        const { meta, buffer, pages } = await extractAndIndexPdf(
          file,
          (pct, label) => {
            setIndexingProgress({ active: true, percent: pct, label });
          }
        );

        await saveBookToDb(meta, buffer, pages);
        setBooks((prev) => [meta, ...prev]);
        setAllPages((prev) => [...prev, ...pages]);
        setPagesLoaded(true);

        void ensureBookPdfLoaded(meta.id, buffer);
      } catch {
        setErrorMessage(
          `امکان پردازش فایل «${file.name}» وجود نداشت. مطمئن شوید فایل سالم و بدون رمز عبور است.`
        );
      }
    }

    setIndexingProgress(null);
  };

  const handleRenameBook = async (bookId: string, newTitle: string) => {
    await updateBookTitleInDb(bookId, newTitle);
    setBooks((prev) =>
      prev.map((b) => (b.id === bookId ? { ...b, title: newTitle } : b))
    );
    setLibraryView((prev) => {
      if (prev.kind !== 'books' && prev.book.id === bookId) {
        return { ...prev, book: { ...prev.book, title: newTitle } };
      }
      return prev;
    });
    setSearchReader((prev) =>
      prev && prev.book.id === bookId
        ? { ...prev, book: { ...prev.book, title: newTitle } }
        : prev
    );
  };

  const handleOpenBook = (book: BookMeta) => {
    setErrorMessage(null);
    const cachedBookPages = pagesByBookId.get(book.id) ?? [];
    if (cachedBookPages.length > 0) {
      setActiveBookPages(cachedBookPages);
    } else {
      void getBookPages(book.id).then((pages) => setActiveBookPages(pages));
    }
    void ensureBookPdfLoaded(book.id);
    setLibraryView({ kind: 'chapters', book });
    window.scrollTo({ top: 0 });
  };

  const handleSelectChapter = (
    book: BookMeta,
    chapter: ChapterHeading,
    initialSearchQuery?: string,
    initialPageNumber?: number
  ) => {
    setErrorMessage(null);
    if (activeBookPages.length === 0 || activeBookPages[0]?.bookId !== book.id) {
      const cachedBookPages = pagesByBookId.get(book.id) ?? [];
      if (cachedBookPages.length > 0) {
        setActiveBookPages(cachedBookPages);
      } else {
        void getBookPages(book.id).then((pages) => setActiveBookPages(pages));
      }
    }

    setLibraryView({
      kind: 'reader',
      book,
      chapter,
      initialSearchQuery,
      initialPageNumber,
    });
  };

  const handleDeleteBook = async (bookId: string) => {
    unloadBookPdf(bookId);
    await deleteBookFromDb(bookId);
    setBooks((prev) => prev.filter((b) => b.id !== bookId));
    setAllPages((prev) => prev.filter((p) => p.bookId !== bookId));
    if (libraryView.kind !== 'books' && libraryView.book.id === bookId) {
      setLibraryView({ kind: 'books' });
    }
    if (searchReader && searchReader.book.id === bookId) {
      setSearchReader(null);
    }
  };

  const handleOpenSearchPage = ({
    bookId,
    chapterId,
    pageNumber,
    query,
  }: {
    bookId: string;
    chapterId: string;
    pageNumber: number;
    query: string;
  }) => {
    const book = books.find((b) => b.id === bookId);
    if (!book) return;
    const normalized = normalizeChaptersTree(book.chapters);
    const chapter =
      findChapterInTree(normalized, chapterId) ?? normalized[0];
    if (!chapter) return;

    const cachedBookPages = pagesByBookId.get(book.id) ?? [];
    setActiveBookPages(cachedBookPages);
    void ensureBookPdfLoaded(book.id);

    // Stay in the Search tab so Back returns directly to the preserved search results
    setSearchReader({
      book,
      chapter,
      initialSearchQuery: query,
      initialPageNumber: pageNumber,
    });
  };

  const isInReader =
    (activeTab === 'library' && libraryView.kind === 'reader') ||
    (activeTab === 'search' && searchReader !== null);

  return (
    <div className="min-h-dvh w-full overflow-x-clip bg-slate-50 text-slate-900">
      {/* Startup Loading Overlay mounted over ready app shell to eliminate white screen flashes */}
      {!splashRemoved && (
        <div
          onTransitionEnd={() => setSplashRemoved(true)}
          className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-50 px-6 text-center transition-opacity duration-200 ${
            startupLoading ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-teal-700 text-white shadow-md">
            <BookOpen className="h-8 w-8" />
          </div>
          <h1 className="mt-5 text-lg font-bold text-slate-900">
            اپلیکیشن جامع اورژانس
          </h1>
          <div
            role="status"
            aria-label="در حال بارگذاری"
            className="mt-6 h-8 w-8 animate-spin rounded-full border-[3px] border-slate-200 border-t-teal-700"
          />
        </div>
      )}

      {/* Slim 1-Row Top Bar (hidden in full-screen PDF reader) */}
      {!isInReader && (
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-md">
          <div className="mx-auto flex h-[52px] max-w-6xl items-center justify-between gap-8 px-4 sm:px-6">
            <button
              type="button"
              onClick={() => {
                setActiveTab('library');
                setLibraryView({ kind: 'books' });
                setSearchReader(null);
              }}
              className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
            >
              کتابخانه پزشکی
            </button>

            <nav
              aria-label="ناوبری دسکتاپ"
              className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600"
            >
              <button
                type="button"
                onClick={() => {
                  setActiveTab('library');
                }}
                className={`transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'library'
                    ? 'font-semibold text-teal-700 underline underline-offset-8'
                    : 'hover:text-slate-900'
                }`}
              >
                کتابخانه
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab('search');
                  setSearchReader(null);
                }}
                className={`transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'search'
                    ? 'font-semibold text-teal-700 underline underline-offset-8'
                    : 'hover:text-slate-900'
                }`}
              >
                جستجو در کتاب‌ها
              </button>
            </nav>

            <div className="flex items-center gap-3 shrink-0">
              {!isOnline && (
                <span className="text-xs font-medium text-amber-700 whitespace-nowrap shrink-0">
                  حالت آفلاین
                </span>
              )}
              <PWAInstallButton />
            </div>
          </div>
        </header>
      )}

      {/* Main Content */}
      <main>
        {activeTab === 'library' &&
          (libraryView.kind === 'books' ? (
            <LibraryBooksView
              books={books}
              isLoadingBooks={false}
              indexingProgress={indexingProgress}
              errorMessage={errorMessage}
              onImportFiles={handleImportFiles}
              onOpenBook={handleOpenBook}
              onRenameBook={(id, title) => void handleRenameBook(id, title)}
              onDeleteBook={(id) => void handleDeleteBook(id)}
            />
          ) : libraryView.kind === 'chapters' ? (
            <BookChaptersView
              book={libraryView.book}
              onBackToBooks={() => setLibraryView({ kind: 'books' })}
              onSelectChapter={(chapter, initialQuery, initialPage) =>
                handleSelectChapter(
                  libraryView.book,
                  chapter,
                  initialQuery,
                  initialPage
                )
              }
            />
          ) : (
            <PdfChapterReader
              book={libraryView.book}
              chapter={libraryView.chapter}
              bookPages={activeBookPages}
              initialSearchQuery={libraryView.initialSearchQuery}
              initialPageNumber={libraryView.initialPageNumber}
              onBackToChapters={() =>
                setLibraryView({ kind: 'chapters', book: libraryView.book })
              }
            />
          ))}

        {/* Keep GlobalSearchView mounted while reading a search result so Back restores exact query & scroll */}
        <div className={activeTab === 'search' && !searchReader ? '' : 'hidden'}>
          <GlobalSearchView
            books={books}
            allPages={allPages}
            isLoadingPages={isLoadingPages}
            onEnsurePagesLoaded={ensureAllPagesLoaded}
            onOpenSearchPage={handleOpenSearchPage}
            onGoToLibrary={() => {
              setActiveTab('library');
              setLibraryView({ kind: 'books' });
            }}
          />
        </div>

        {activeTab === 'search' && searchReader && (
          <PdfChapterReader
            book={searchReader.book}
            chapter={searchReader.chapter}
            bookPages={activeBookPages}
            initialSearchQuery={searchReader.initialSearchQuery}
            initialPageNumber={searchReader.initialPageNumber}
            onBackToChapters={() => setSearchReader(null)}
          />
        )}
      </main>

      {/* Fixed Bottom 2-Tab Navigation Bar */}
      {!isInReader && (
        <BottomTabBar
          activeTab={activeTab}
          onSelectTab={(tab) => {
            setActiveTab(tab);
            if (tab === 'search') {
              setSearchReader(null);
            }
            window.scrollTo({ top: 0 });
          }}
        />
      )}
    </div>
  );
}
