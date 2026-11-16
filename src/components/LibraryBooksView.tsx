import React, { useEffect, useRef, useState } from 'react';
import {
  Book,
  Check,
  ChevronLeft,
  FilePlus2,
  FolderPlus,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import { BookMeta } from '../types/library';
import { toPersianDigits } from '../utils/arabicNormalize';
import { getBookCoverDataUrl, getCachedBookCover } from '../services/pdfCache';

interface BookCoverThumbProps {
  bookId: string;
  title: string;
}

const BookCoverThumb: React.FC<BookCoverThumbProps> = ({ bookId, title }) => {
  const [coverUrl, setCoverUrl] = useState<string | null>(() =>
    getCachedBookCover(bookId)
  );

  useEffect(() => {
    const existing = getCachedBookCover(bookId);
    if (existing) {
      setCoverUrl(existing);
      return;
    }
    let active = true;
    void getBookCoverDataUrl(bookId).then((url) => {
      if (active && url) {
        setCoverUrl(url);
      }
    });
    return () => {
      active = false;
    };
  }, [bookId]);

  return (
    <div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xs">
      {coverUrl ? (
        <img
          src={coverUrl}
          alt={`صفحه اول ${title}`}
          className="h-full w-full object-contain bg-white"
        />
      ) : (
        <Book className="h-4 w-4 text-slate-300" />
      )}
    </div>
  );
};

interface LibraryBooksViewProps {
  books: BookMeta[];
  isLoadingBooks: boolean;
  indexingProgress: { active: boolean; percent: number; label: string } | null;
  errorMessage: string | null;
  onImportFiles: (files: FileList | File[]) => void;
  onOpenBook: (book: BookMeta) => void;
  onRenameBook: (bookId: string, newTitle: string) => void;
  onDeleteBook: (bookId: string) => void;
}

export const LibraryBooksView: React.FC<LibraryBooksViewProps> = ({
  books,
  isLoadingBooks,
  indexingProgress,
  errorMessage,
  onImportFiles,
  onOpenBook,
  onRenameBook,
  onDeleteBook,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingBookId, setEditingBookId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  const triggerFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onImportFiles(e.target.files);
      e.target.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onImportFiles(e.dataTransfer.files);
    }
  };

  const startEditing = (book: BookMeta) => {
    setConfirmDeleteId(null);
    setEditingBookId(book.id);
    setEditingTitle(book.title);
  };

  const saveEdit = (bookId: string) => {
    const trimmed = editingTitle.trim();
    if (trimmed) {
      onRenameBook(bookId, trimmed);
    }
    setEditingBookId(null);
    setEditingTitle('');
  };

  const cancelEdit = () => {
    setEditingBookId(null);
    setEditingTitle('');
  };

  return (
    <div
      className="mx-auto w-full max-w-6xl px-4 pb-24 pt-5 sm:px-6"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Section Header & Primary Add Book CTA */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
          کتاب‌ها
        </h1>

        <button
          type="button"
          onClick={triggerFilePicker}
          disabled={!!indexingProgress?.active}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-800 disabled:opacity-60 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
        >
          <FilePlus2 className="h-4 w-4 shrink-0" />
          <span>افزودن کتاب PDF</span>
        </button>
      </div>

      {/* Indexing Progress Bar */}
      {indexingProgress?.active && (
        <div className="mt-4 rounded-2xl border border-teal-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3 text-sm font-medium text-slate-800">
            <span className="truncate">{indexingProgress.label}</span>
            <span className="tabular-nums text-teal-700 shrink-0">
              {toPersianDigits(indexingProgress.percent)}٪
            </span>
          </div>
          <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full bg-teal-700 transition-all duration-150"
              style={{ width: `${indexingProgress.percent}%` }}
            />
          </div>
        </div>
      )}

      {/* Error Message */}
      {errorMessage && (
        <div
          role="alert"
          className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          {errorMessage}
        </div>
      )}

      {/* Drag Overlay Hint */}
      {isDragging && (
        <div className="mt-4 rounded-2xl border-2 border-dashed border-teal-600 bg-teal-50/70 p-8 text-center text-sm font-semibold text-teal-800">
          فایل PDF را اینجا رها کنید تا به کتابخانه آفلاین اضافه شود
        </div>
      )}

      {isLoadingBooks ? (
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((idx) => (
            <div
              key={idx}
              className="h-16 animate-pulse rounded-2xl border border-slate-200 bg-white"
            />
          ))}
        </div>
      ) : books.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-50 text-teal-700">
            <FolderPlus className="h-7 w-7" />
          </div>
          <h2 className="mt-4 text-lg font-bold text-slate-900">
            هنوز کتابی اضافه نشده است
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-600">
            فایل‌های پی‌دی‌اف خود را از حافظه دستگاه انتخاب کنید تا به کتابخانه آفلاین اضافه شوند.
          </p>

          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={triggerFilePicker}
              className="inline-flex min-h-[48px] items-center gap-2 rounded-xl bg-teal-700 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-teal-800 whitespace-nowrap shrink-0"
            >
              <FilePlus2 className="h-4 w-4 shrink-0" />
              <span>انتخاب فایل PDF از دستگاه</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {books.map((book) => {
            const isConfirming = confirmDeleteId === book.id;
            const isEditing = editingBookId === book.id;

            return (
              <div
                key={book.id}
                className="group flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white pr-4 pl-2 transition-colors hover:border-teal-600/40"
              >
                {isEditing ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveEdit(book.id);
                    }}
                    className="flex min-h-[60px] w-full items-center gap-2 py-2"
                  >
                    <input
                      type="text"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      autoFocus
                      dir="auto"
                      aria-label="ویرایش نام کتاب"
                      className="min-h-[40px] min-w-0 flex-1 rounded-xl border border-teal-600 bg-slate-50 px-3 text-sm font-semibold text-slate-900 focus:bg-white focus:outline-none"
                    />
                    <button
                      type="submit"
                      aria-label="ذخیره نام جدید"
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-700 text-white hover:bg-teal-800"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      aria-label="انصراف از ویرایش"
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => onOpenBook(book)}
                      className="flex min-h-[68px] min-w-0 flex-1 items-center gap-3 py-2.5 text-right focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
                    >
                      <BookCoverThumb bookId={book.id} title={book.title} />
                      <span
                        dir="auto"
                        className="line-clamp-2 flex-1 text-base font-bold leading-snug text-slate-900"
                      >
                        {book.title}
                      </span>
                      <ChevronLeft className="h-5 w-5 shrink-0 text-slate-400 transition-transform group-hover:-translate-x-0.5 group-hover:text-teal-700" />
                    </button>

                    {isConfirming ? (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            onDeleteBook(book.id);
                            setConfirmDeleteId(null);
                          }}
                          className="min-h-[36px] rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-rose-700 whitespace-nowrap"
                        >
                          حذف
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="min-h-[36px] rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap"
                        >
                          لغو
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center shrink-0">
                        <button
                          type="button"
                          onClick={() => startEditing(book)}
                          aria-label={`ویرایش نام ${book.title}`}
                          className="flex min-h-[42px] min-w-[42px] items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-teal-50 hover:text-teal-700"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(book.id)}
                          aria-label={`حذف ${book.title}`}
                          className="flex min-h-[42px] min-w-[42px] items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
