import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
} from 'lucide-react';
import { BookMeta, ChapterHeading } from '../types/library';
import { normalizeChaptersTree } from '../services/pdfEngine';
import { prewarmBookPages } from '../services/pdfCache';
import { ScrollToTopButton } from './ScrollToTopButton';

interface BookChaptersViewProps {
  book: BookMeta;
  onBackToBooks: () => void;
  onSelectChapter: (
    chapter: ChapterHeading,
    initialQuery?: string,
    initialPage?: number
  ) => void;
}

interface TopicNodeRowProps {
  topic: ChapterHeading;
  depth: number;
  expandedIds: Set<string>;
  onToggleExpand: (topic: ChapterHeading) => void;
  onOpenTopic: (topic: ChapterHeading) => void;
}

const TopicNodeRow: React.FC<TopicNodeRowProps> = ({
  topic,
  depth,
  expandedIds,
  onToggleExpand,
  onOpenTopic,
}) => {
  const children = topic.children ?? [];
  const hasChildren = children.length > 0;
  const isExpanded = expandedIds.has(topic.id);

  const paddingClass =
    depth === 0 ? 'pr-4' : depth === 1 ? 'pr-8' : 'pr-12';

  return (
    <div>
      <div className={`flex min-h-[54px] w-full items-center gap-2 py-1.5 pl-3 ${paddingClass}`}>
        {/* Tapping the chapter/topic title itself always opens its first page directly */}
        <button
          type="button"
          onClick={() => onOpenTopic(topic)}
          className="flex min-h-[44px] min-w-0 flex-1 items-center py-1.5 text-right transition-colors hover:text-teal-800 active:opacity-75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
        >
          <span
            dir="auto"
            className={`flex-1 leading-snug ${
              depth === 0
                ? 'text-sm font-semibold text-slate-900 sm:text-base'
                : 'text-sm font-normal text-slate-700'
            }`}
          >
            {topic.title}
          </span>
        </button>

        {/* Left-side dedicated button to show/hide sub-topics (arrow-down only) */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleExpand(topic)}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'بستن ساب‌تاپیک‌ها' : 'نمایش ساب‌تاپیک‌ها'}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-colors ${
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
            onClick={() => onOpenTopic(topic)}
            aria-label="باز کردن صفحه اول"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-50 hover:text-teal-700"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
      </div>

      {hasChildren && isExpanded && (
        <div className="divide-y divide-slate-100 border-t border-slate-100 bg-slate-50/70">
          {children.map((subTopic) => (
            <TopicNodeRow
              key={subTopic.id}
              topic={subTopic}
              depth={depth + 1}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              onOpenTopic={onOpenTopic}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const BookChaptersView: React.FC<BookChaptersViewProps> = ({
  book,
  onBackToBooks,
  onSelectChapter,
}) => {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showScrollTop, setShowScrollTop] = useState(false);

  const mainTopics = useMemo(
    () => normalizeChaptersTree(book.chapters),
    [book.chapters]
  );

  useEffect(() => {
    setExpandedIds(new Set());
  }, [book.id]);

  // Pre-render the opening pages of the first several main chapters silently in background
  useEffect(() => {
    const pagesToWarm = mainTopics.slice(0, 5).map((t) => t.startPage);
    return prewarmBookPages(book.id, pagesToWarm);
  }, [book.id, mainTopics]);

  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 200);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const toggleExpand = (topic: ChapterHeading) => {
    const willExpand = !expandedIds.has(topic.id);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(topic.id)) {
        next.delete(topic.id);
      } else {
        next.add(topic.id);
      }
      return next;
    });

    if (willExpand) {
      const subPages = [
        topic.startPage,
        ...(topic.children ?? []).slice(0, 5).map((c) => c.startPage),
      ];
      prewarmBookPages(book.id, subPages);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-24 pt-4 sm:px-6">
      {/* Header Row with Back & Book Title */}
      <div className="flex items-center gap-3 border-b border-slate-200 pb-3.5">
        <button
          type="button"
          onClick={onBackToBooks}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 transition-colors hover:bg-slate-50 shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
          aria-label="بازگشت به لیست کتاب‌ها"
        >
          <ArrowRight className="h-5 w-5" />
        </button>

        <div className="min-w-0 flex-1">
          <h1
            dir="auto"
            className="truncate text-lg font-bold text-slate-900 sm:text-xl"
          >
            {book.title}
          </h1>
        </div>
      </div>

      {/* Main Topics Only — Tap chapter title to open its first page; tap left button for sub-topics */}
      <div className="mt-5">
        <h2 className="mb-2.5 text-xs font-semibold text-slate-500">
          سرفصل‌های اصلی کتاب
        </h2>

        <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {mainTopics.map((topic) => (
            <TopicNodeRow
              key={topic.id}
              topic={topic}
              depth={0}
              expandedIds={expandedIds}
              onToggleExpand={toggleExpand}
              onOpenTopic={(selected) =>
                onSelectChapter(selected, undefined, selected.startPage)
              }
            />
          ))}
        </div>
      </div>

      <ScrollToTopButton
        visible={showScrollTop}
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        hasBottomNav={true}
      />
    </div>
  );
};
