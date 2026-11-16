import React, { useEffect, useMemo, useState } from 'react';
import {
  Book,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  Search,
  X,
} from 'lucide-react';
import {
  BookMeta,
  ChapterSearchGroup,
  PageTextEntry,
} from '../types/library';
import { searchChaptersAcrossBooks } from '../services/pdfEngine';
import { prewarmBookPages } from '../services/pdfCache';
import { ScrollToTopButton } from './ScrollToTopButton';

interface GlobalSearchViewProps {
  books: BookMeta[];
  allPages: PageTextEntry[];
  isLoadingPages: boolean;
  onEnsurePagesLoaded: () => Promise<PageTextEntry[]>;
  onOpenSearchPage: (params: {
    bookId: string;
    chapterId: string;
    pageNumber: number;
    query: string;
  }) => void;
  onGoToLibrary: () => void;
}

export const GlobalSearchView: React.FC<GlobalSearchViewProps> = ({
  books,
  allPages,
  isLoadingPages,
  onEnsurePagesLoaded,
  onOpenSearchPage,
  onGoToLibrary,
}) => {
  const [draftQuery, setDraftQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [collapsedBookIds, setCollapsedBookIds] = useState<Set<string>>(
    new Set()
  );
  const [expandedChapterIds, setExpandedChapterIds] = useState<Set<string>>(
    new Set()
  );
  const [showScrollTop, setShowScrollTop] = useState(false);

  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 200);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const chapterGroups = useMemo(() => {
    if (submittedQuery.trim().length < 2 || books.length === 0) return [];
    return searchChaptersAcrossBooks(books, allPages, submittedQuery);
  }, [books, allPages, submittedQuery]);

  // Group chapters strictly under each Book banner, ordered by highest relevance
  const groupedByBook = useMemo(() => {
    const map = new Map<
      string,
      {
        bookId: string;
        bookTitle: string;
        topRelevance: number;
        chapters: ChapterSearchGroup[];
      }
    >();
    for (const ch of chapterGroups) {
      let entry = map.get(ch.bookId);
      const chapterWeight =
        (ch.titleMatches ? 10000 : 0) + ch.totalOccurrences;
      if (!entry) {
        entry = {
          bookId: ch.bookId,
          bookTitle: ch.bookTitle,
          topRelevance: chapterWeight,
          chapters: [],
        };
        map.set(ch.bookId, entry);
      } else if (chapterWeight > entry.topRelevance) {
        entry.topRelevance = chapterWeight;
      }
      entry.chapters.push(ch);
    }
    return Array.from(map.values()).sort(
      (a, b) => b.topRelevance - a.topRelevance
    );
  }, [chapterGroups]);

  // Pre-render the top search result pages silently so tapping a result opens immediately
  useEffect(() => {
    if (groupedByBook.length === 0) return;
    const cleanups: Array<() => void> = [];
    for (const bookGroup of groupedByBook.slice(0, 3)) {
      const topPages = bookGroup.chapters
        .slice(0, 4)
        .map((c) => c.bestPageNumber);
      cleanups.push(prewarmBookPages(bookGroup.bookId, topPages));
    }
    return () => {
      for (const cancel of cleanups) cancel();
    };
  }, [groupedByBook]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = draftQuery.trim();
    if (cleaned.length < 2) {
      setSubmittedQuery('');
      return;
    }
    setIsSearching(true);
    try {
      await onEnsurePagesLoaded();
      setCollapsedBookIds(new Set());
      setExpandedChapterIds(new Set());
      setSubmittedQuery(cleaned);
    } finally {
      setIsSearching(false);
    }
  };

  const handleClear = () => {
    setDraftQuery('');
    setSubmittedQuery('');
    setCollapsedBookIds(new Set());
    setExpandedChapterIds(new Set());
  };

  const toggleBookCollapse = (bookId: string) => {
    setCollapsedBookIds((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) {
        next.delete(bookId);
      } else {
        next.add(bookId);
      }
      return next;
    });
  };

  const handleOpenChapter = (group: ChapterSearchGroup) => {
    onOpenSearchPage({
      bookId: group.bookId,
      chapterId: group.chapterId,
      pageNumber: group.bestPageNumber,
      query: submittedQuery,
    });
  };

  const toggleChapterSubTopics = (group: ChapterSearchGroup) => {
    const willExpand = !expandedChapterIds.has(group.id);
    setExpandedChapterIds((prev) => {
      const next = new Set(prev);
      if (next.has(group.id)) {
        next.delete(group.id);
      } else {
        next.add(group.id);
      }
      return next;
    });
    if (willExpand) {
      const subPages = group.matchingSubTopics
        .slice(0, 5)
        .map((s) => s.pageNumber);
      prewarmBookPages(group.bookId, subPages);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl pb-24">
      {/* Search Bar Header */}
      <div className="px-4 pt-4 pb-3 sm:px-6">
        <h1 className="mb-3 text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
          جستجو در مجموعه کتاب‌ها
        </h1>

        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="flex items-center gap-2"
        >
          <div className="relative flex flex-1 items-center">
            <Search className="pointer-events-none absolute right-3.5 h-5 w-5 text-slate-400" />
            <input
              type="search"
              value={draftQuery}
              onChange={(e) => {
                const val = e.target.value;
                setDraftQuery(val);
                if (!val.trim()) setSubmittedQuery('');
              }}
              placeholder="عبارت مورد نظر را بنویسید..."
              className="min-h-[48px] w-full rounded-xl border border-slate-200 bg-white pr-11 pl-10 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none sm:text-base"
            />
            {draftQuery && (
              <button
                type="button"
                onClick={handleClear}
                aria-label="پاک کردن عبارت جستجو"
                className="absolute left-1.5 flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <button
            type="submit"
            disabled={
              isSearching || isLoadingPages || draftQuery.trim().length < 2
            }
            className="min-h-[48px] rounded-xl bg-teal-700 px-5 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {isSearching ? 'در حال جستجو...' : 'جستجو'}
          </button>
        </form>
      </div>

      {books.length === 0 ? (
        <div className="mx-4 mt-4 rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center sm:mx-6">
          <p className="text-sm font-medium text-slate-700">
            برای جستجو در مجموعه کتاب‌ها، ابتدا حداقل یک کتاب PDF به کتابخانه اضافه کنید.
          </p>
          <button
            type="button"
            onClick={onGoToLibrary}
            className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-teal-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-800"
          >
            <BookOpen className="h-4 w-4" />
            <span>رفتن به تب کتابخانه</span>
          </button>
        </div>
      ) : submittedQuery.length < 2 ? null : groupedByBook.length === 0 ? (
        <div className="mx-4 mt-4 rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-500 sm:mx-6">
          نتیجه‌ای برای «{submittedQuery}» یافت نشد.
        </div>
      ) : (
        /* Full-width Book separator header + Chapter rows (tap chapter -> open chapter; tap left button -> sub-topics) */
        <div className="mt-1 space-y-0 border-t border-slate-200">
          {groupedByBook.map((bookGroup) => {
            const isCollapsed = collapsedBookIds.has(bookGroup.bookId);

            return (
              <section key={bookGroup.bookId}>
                {/* Clickable Dark Book Banner — tap to collapse/expand book's chapters */}
                <button
                  type="button"
                  onClick={() => toggleBookCollapse(bookGroup.bookId)}
                  aria-expanded={!isCollapsed}
                  className="flex min-h-[54px] w-full items-center justify-between gap-3 bg-slate-700 px-4 py-3 text-right text-white transition-colors hover:bg-slate-800 sm:px-6"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="flex h-9 w-7 shrink-0 items-center justify-center rounded bg-slate-800/80 text-teal-300">
                      <Book className="h-4 w-4" />
                    </div>
                    <span
                      dir="auto"
                      className="line-clamp-2 flex-1 text-sm font-semibold leading-snug sm:text-base"
                    >
                      {bookGroup.bookTitle}
                    </span>
                  </div>
                  <ChevronDown
                    className={`h-5 w-5 shrink-0 text-slate-300 transition-transform duration-150 ${
                      isCollapsed ? 'rotate-90' : ''
                    }`}
                  />
                </button>

                {/* Matching Chapters inside this Book */}
                {!isCollapsed && (
                  <div className="divide-y divide-slate-200 bg-white">
                    {bookGroup.chapters.map((group) => {
                      const hasSubs = group.matchingSubTopics.length > 0;
                      const isExpanded = expandedChapterIds.has(group.id);

                      return (
                        <div key={group.id}>
                          <div className="flex w-full items-start gap-2.5 px-4 py-3.5 sm:px-6">
                            {/* Tapping the chapter itself always opens the chapter directly */}
                            <button
                              type="button"
                              onClick={() => handleOpenChapter(group)}
                              className="min-w-0 flex-1 text-right transition-colors hover:opacity-85 active:opacity-70"
                            >
                              <h3
                                dir="auto"
                                className="text-base font-bold leading-snug text-slate-950"
                              >
                                {group.chapterTitle}
                              </h3>

                              {(group.previewBefore || group.previewMatch) && (
                                <p
                                  dir="auto"
                                  className="mt-1 line-clamp-3 text-sm leading-relaxed text-slate-500"
                                >
                                  {group.previewBefore}
                                  {group.previewMatch && (
                                    <strong className="font-bold text-slate-800">
                                      {group.previewMatch}
                                    </strong>
                                  )}
                                  {group.previewAfter}
                                </p>
                              )}
                            </button>

                            {/* Left-side dedicated arrow button to show/hide clinically ordered sub-topics */}
                            {hasSubs ? (
                              <button
                                type="button"
                                onClick={() => toggleChapterSubTopics(group)}
                                aria-expanded={isExpanded}
                                aria-label={
                                  isExpanded
                                    ? 'بستن ساب‌تاپیک‌ها'
                                    : 'نمایش ساب‌تاپیک‌ها'
                                }
                                className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-colors ${
                                  isExpanded
                                    ? 'border-teal-700 bg-teal-700 text-white'
                                    : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800'
                                }`}
                              >
                                <ChevronDown
                                  className={`h-4 w-4 transition-transform duration-150 ${
                                    isExpanded ? 'rotate-180' : ''
                                  }`}
                                />
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleOpenChapter(group)}
                                aria-label="باز کردن چپتر"
                                className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-50 hover:text-teal-700"
                              >
                                <ChevronLeft className="h-5 w-5" />
                              </button>
                            )}
                          </div>

                          {/* Matching Sub-topics ordered: Management -> Disposition -> Diagnostic -> Clinical Signs -> Pathophysiology */}
                          {hasSubs && isExpanded && (
                            <div className="divide-y divide-slate-200/70 border-t border-slate-200 border-r-4 border-r-teal-700 bg-slate-50">
                              {group.matchingSubTopics.map((sub) => (
                                <button
                                  key={sub.id}
                                  type="button"
                                  onClick={() =>
                                    onOpenSearchPage({
                                      bookId: group.bookId,
                                      chapterId: sub.chapterId,
                                      pageNumber: sub.pageNumber,
                                      query: submittedQuery,
                                    })
                                  }
                                  className="flex w-full items-start justify-between gap-3 px-4 py-3 text-right transition-colors hover:bg-slate-100 active:bg-slate-200/70 sm:px-6"
                                >
                                  <div className="min-w-0 flex-1">
                                    {sub.parentTitle && (
                                      <p
                                        dir="auto"
                                        className="mb-0.5 truncate text-[11px] font-medium text-teal-700"
                                      >
                                        {sub.parentTitle}
                                      </p>
                                    )}
                                    <p
                                      dir="auto"
                                      className="text-sm font-bold leading-snug text-slate-900"
                                    >
                                      {sub.title}
                                    </p>

                                    {(sub.previewBefore || sub.previewMatch) && (
                                      <p
                                        dir="auto"
                                        className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500"
                                      >
                                        {sub.previewBefore}
                                        {sub.previewMatch && (
                                          <strong className="font-bold text-slate-800">
                                            {sub.previewMatch}
                                          </strong>
                                        )}
                                        {sub.previewAfter}
                                      </p>
                                    )}
                                  </div>

                                  <ChevronLeft className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <ScrollToTopButton
        visible={showScrollTop}
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        hasBottomNav={true}
      />
    </div>
  );
};
