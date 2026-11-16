import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  BookMeta,
  ChapterHeading,
  ChapterSearchGroup,
  PageTextEntry,
  SearchMatch,
  SubTopicSearchHit,
} from '../types/library';
import {
  findMatchRangesInRawText,
  normalizeForSearch,
  toPersianDigits,
} from '../utils/arabicNormalize';
import {
  classifyClinicalTopic,
  getTopicPriority,
} from '../utils/topicClassifier';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export function createPdfLoadingTaskFromBuffer(buffer: ArrayBuffer): {
  loadingTask: ReturnType<typeof pdfjsLib.getDocument>;
  cleanup: () => void;
} {
  // Using a local blob: URL avoids cloning large multi-megabyte ArrayBuffers on the main thread
  const blob = new Blob([buffer], { type: 'application/pdf' });
  const blobUrl = URL.createObjectURL(blob);
  const loadingTask = pdfjsLib.getDocument({
    url: blobUrl,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
    useSystemFonts: true,
  });

  let revoked = false;
  const cleanup = () => {
    void loadingTask.destroy();
    if (!revoked) {
      revoked = true;
      URL.revokeObjectURL(blobUrl);
    }
  };

  return { loadingTask, cleanup };
}

interface RawOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: RawOutlineNode[];
}

interface OutlineTreeDraft {
  title: string;
  level: number;
  startPage: number | null;
  children: OutlineTreeDraft[];
}

const REFERENCE_TITLE_PATTERN =
  /^(references?|selected\s+references?|key\s+references?|chapter\s+references?|online\s+references?|references?\s+and\s+suggested\s+readings?|bibliography|works\s+cited|further\s+reading|suggested\s+readings?|reading\s+list|acknowledg(e)?ments?|author\s+index|subject\s+index|index|glossary|appendix|منابع|منابع\s+و\s+م[آا]خذ|منابع\s+و\s+مراجع|م[آا]خذ|مراجع|رفرنس(\u200c|\s)*ها?|کتابنامه|فهرست\s+منابع|واژه\u200c?نامه)$/i;

export function isReferenceHeading(title: string): boolean {
  const clean = title
    .replace(/^[\d۰-۹.\-–—:()\s]+/, '')
    .replace(/[\d۰-۹.\-–—:()\s]+$/, '')
    .trim();
  if (!clean) return false;
  if (REFERENCE_TITLE_PATTERN.test(clean)) return true;

  // Match "Chapter X - References", "References Cited", etc.
  if (
    /([-–—:|/]\s*|\b(chapter|section|selected|key|online)\s+)(references?|bibliography|works\s+cited|further\s+reading|suggested\s+readings?|reading\s+list)\b/i.test(
      clean
    )
  ) {
    return true;
  }
  if (
    /^(references?|bibliography|works\s+cited|further\s+reading|suggested\s+readings?)\b/i.test(
      clean
    )
  ) {
    return true;
  }
  if (
    /(^|[\s\-–—:|/])(منابع\s+و\s+م[آا]خذ|فهرست\s+منابع|کتابنامه|منابع\s+فصل|مراجع\s+فصل|رفرنس(\u200c|\s)*ها?|منابع|م[آا]خذ|مراجع)(\s|$)/i.test(
      clean
    ) &&
    clean.length <= 60
  ) {
    return true;
  }
  return false;
}

const REFERENCE_SECTION_LINE_RE =
  /^(references?|selected\s+references?|key\s+references?|bibliography|works\s+cited|further\s+reading|suggested\s+readings?|منابع(\s+و\s+م[آا]خذ)?|مراجع|کتابنامه|رفرنس(\u200c|\s)*ها?)\s*:?$/i;

const CITATION_LINE_RE =
  /^(?:\[\d{1,3}\]|\d{1,3}\.)\s+[A-Z\u0600-\u06FF].*(?:et\s+al\.?|;\s*\d+|:\s*\d+[-–]\d+|\b(19|20)\d{2}\b|\bdoi\b|\bpp\.|\bvol\.|J\s+Emerg|N\s+Engl|JAMA|Ann\s+Emerg|Acad\s+Emerg|Pediatr|Lancet|BMJ)/i;

/**
 * Removes reference sections from a page's searchable text, and returns null
 * if the page itself is predominantly a bibliography / reference list page.
 */
function getSearchableNonReferenceText(rawText: string): string | null {
  if (!rawText) return null;
  const lines = rawText.split(/\r?\n/);

  // Count academic citation lines across the page
  let citationCount = 0;
  let nonEmptyCount = 0;
  let firstHeadingLineIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    nonEmptyCount++;

    if (firstHeadingLineIdx === -1 && REFERENCE_SECTION_LINE_RE.test(trimmed)) {
      firstHeadingLineIdx = i;
    }
    if (CITATION_LINE_RE.test(trimmed)) {
      citationCount++;
    }
  }

  // If a References heading appears near the very top of the page, skip the entire page
  if (firstHeadingLineIdx !== -1) {
    const nonEmptyBeforeRef = lines
      .slice(0, firstHeadingLineIdx)
      .filter((l) => l.trim().length > 0).length;
    if (nonEmptyBeforeRef <= 3) {
      return null;
    }
    // Truncate content at the start of the References section on mixed pages
    return lines.slice(0, firstHeadingLineIdx).join('\n');
  }

  // Continuation reference pages (e.g. "28. Kitabchi AE... Ann Emerg Med 2009; 54:12...")
  if (citationCount >= 5 || (nonEmptyCount > 0 && citationCount >= 3 && citationCount / nonEmptyCount >= 0.35)) {
    return null;
  }

  return rawText;
}

async function resolveOutlinePage(
  pdf: PDFDocumentProxy,
  dest: string | unknown[] | null
): Promise<number | null> {
  if (!dest) return null;
  try {
    let explicitDest: unknown[] | null = null;
    if (typeof dest === 'string') {
      explicitDest = await pdf.getDestination(dest);
    } else if (Array.isArray(dest)) {
      explicitDest = dest;
    }
    if (!explicitDest || explicitDest.length === 0) return null;
    const ref = explicitDest[0];
    if (typeof ref === 'number') {
      return ref + 1 >= 1 && ref + 1 <= pdf.numPages ? ref + 1 : null;
    }
    if (ref && typeof ref === 'object') {
      const pageIndex = await pdf.getPageIndex(
        ref as Parameters<PDFDocumentProxy['getPageIndex']>[0]
      );
      const p = pageIndex + 1;
      return p >= 1 && p <= pdf.numPages ? p : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function buildOutlineDraftTree(
  pdf: PDFDocumentProxy,
  items: RawOutlineNode[],
  level = 0
): Promise<OutlineTreeDraft[]> {
  const nodes: OutlineTreeDraft[] = [];
  for (const item of items) {
    const cleanTitle = (item.title || '').replace(/\s+/g, ' ').trim();
    const pageNum = await resolveOutlinePage(pdf, item.dest);
    const children =
      item.items && item.items.length > 0
        ? await buildOutlineDraftTree(pdf, item.items, level + 1)
        : [];

    const resolvedPage =
      pageNum ??
      children.find((c) => c.startPage !== null)?.startPage ??
      null;

    if (cleanTitle && (resolvedPage !== null || children.length > 0)) {
      nodes.push({
        title: cleanTitle,
        level,
        startPage: resolvedPage,
        children,
      });
    }
  }
  return nodes;
}

function unwrapRedundantRootOutline(
  nodes: OutlineTreeDraft[]
): OutlineTreeDraft[] {
  let current = nodes;
  while (current.length === 1 && current[0].children.length >= 2) {
    current = current[0].children;
  }
  const relevel = (list: OutlineTreeDraft[], lvl: number): OutlineTreeDraft[] =>
    list.map((n) => ({
      ...n,
      level: lvl,
      children: relevel(n.children, lvl + 1),
    }));
  return relevel(current, 0);
}

function finalizeTreeRanges(
  nodes: OutlineTreeDraft[],
  parentEndPage: number,
  idPrefix = 'ch'
): ChapterHeading[] {
  const valid = nodes.filter((n) => n.startPage !== null);
  return valid.map((node, idx) => {
    const startPage = node.startPage as number;
    let endPage = parentEndPage;

    for (let j = idx + 1; j < valid.length; j++) {
      const nextStart = valid[j].startPage as number;
      if (nextStart > startPage) {
        endPage = Math.max(startPage, nextStart - 1);
        break;
      }
      if (nextStart === startPage) {
        endPage = startPage;
        break;
      }
    }

    endPage = Math.min(parentEndPage, Math.max(startPage, endPage));
    const id = `${idPrefix}-${idx + 1}`;
    const children =
      node.children.length > 0
        ? finalizeTreeRanges(node.children, endPage, id)
        : [];

    return {
      id,
      title: node.title,
      level: node.level,
      startPage,
      endPage,
      children,
    };
  });
}

interface TextItemLike {
  str: string;
  hasEOL?: boolean;
  transform: number[];
  width?: number;
}

interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

interface VisualLine {
  text: string;
  y: number;
  x: number;
  fontSize: number;
}

function extractFastPageText(rawItems: unknown[]): string {
  let out = '';
  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i] as TextItemLike;
    if (typeof item.str !== 'string' || item.str.length === 0) continue;
    if (out.length > 0 && !out.endsWith(' ') && !out.endsWith('\n') && !item.str.startsWith(' ')) {
      out += ' ';
    }
    out += item.str;
    if (item.hasEOL) {
      out += '\n';
    }
  }
  return out.trim();
}

function sortAndJoinLineItems(items: PositionedItem[]): string {
  if (items.length === 0) return '';
  const combinedPreview = items.map((i) => i.str).join('');
  const rtlChars = (combinedPreview.match(/[\u0600-\u06FF]/g) || []).length;
  const ltrChars = (combinedPreview.match(/[A-Za-z]/g) || []).length;
  const isPredominantlyRtl = rtlChars > ltrChars;

  const sorted = [...items].sort((a, b) =>
    isPredominantlyRtl ? b.x - a.x : a.x - b.x
  );

  let line = '';
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    if (!cur.str) continue;
    if (line.length > 0) {
      const prev = sorted[i - 1];
      const gap = isPredominantlyRtl
        ? prev.x - (cur.x + cur.width)
        : cur.x - (prev.x + prev.width);
      const needsSpace =
        gap > Math.max(1.2, cur.fontSize * 0.16) &&
        !line.endsWith(' ') &&
        !cur.str.startsWith(' ');
      if (needsSpace) {
        line += ' ';
      }
    }
    line += cur.str;
  }

  return line.replace(/\s+/g, ' ').trim();
}

function groupColumnItemsIntoLines(items: PositionedItem[]): VisualLine[] {
  if (items.length === 0) return [];
  const sortedByY = [...items].sort((a, b) => b.y - a.y);

  const buckets: PositionedItem[][] = [];
  for (const item of sortedByY) {
    const lastBucket = buckets[buckets.length - 1];
    const tol = Math.max(3.5, item.fontSize * 0.42);
    if (lastBucket && Math.abs(lastBucket[0].y - item.y) <= tol) {
      lastBucket.push(item);
    } else {
      buckets.push([item]);
    }
  }

  const lines: VisualLine[] = [];
  for (const bucket of buckets) {
    const text = sortAndJoinLineItems(bucket);
    if (!text) continue;
    const avgY = bucket.reduce((s, i) => s + i.y, 0) / bucket.length;
    const minX = Math.min(...bucket.map((i) => i.x));
    const maxFont = Math.max(...bucket.map((i) => i.fontSize));
    lines.push({ text, y: avgY, x: minX, fontSize: maxFont });
  }
  return lines;
}

function reconstructPageLinesAndText(
  rawItems: unknown[],
  pageWidth: number
): { rawText: string; lines: VisualLine[] } {
  const positioned: PositionedItem[] = [];
  for (const raw of rawItems) {
    const item = raw as TextItemLike;
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    const t = Array.isArray(item.transform) ? item.transform : [10, 0, 0, 10, 0, 0];
    const fontSize = Math.hypot(t[0] || 0, t[1] || 0) || 10;
    positioned.push({
      str: item.str,
      x: t[4] || 0,
      y: t[5] || 0,
      width: typeof item.width === 'number' ? item.width : item.str.length * fontSize * 0.45,
      fontSize,
    });
  }

  if (positioned.length === 0) {
    return { rawText: '', lines: [] };
  }

  const midX = pageWidth * 0.5;
  const gutterBandLeft = pageWidth * 0.42;
  const gutterBandRight = pageWidth * 0.58;
  const leftItems = positioned.filter((i) => i.x + i.width <= gutterBandRight && i.x < midX);
  const rightItems = positioned.filter((i) => i.x >= gutterBandLeft);
  const crossingItems = positioned.filter(
    (i) => i.x < gutterBandLeft && i.x + i.width > gutterBandRight
  );

  const isTwoColumn =
    leftItems.length >= 12 &&
    rightItems.length >= 12 &&
    crossingItems.length <= Math.max(4, positioned.length * 0.08);

  let orderedLines: VisualLine[];
  if (isTwoColumn) {
    const sampleText = positioned.slice(0, 40).map((p) => p.str).join('');
    const isRtlDoc =
      (sampleText.match(/[\u0600-\u06FF]/g) || []).length >
      (sampleText.match(/[A-Za-z]/g) || []).length;

    const topFullWidth = groupColumnItemsIntoLines(crossingItems);
    const colA = groupColumnItemsIntoLines(isRtlDoc ? rightItems : leftItems);
    const colB = groupColumnItemsIntoLines(isRtlDoc ? leftItems : rightItems);
    orderedLines = [...topFullWidth, ...colA, ...colB];
  } else {
    orderedLines = groupColumnItemsIntoLines(positioned);
  }

  const rawText = orderedLines.map((l) => l.text).join('\n');
  return { rawText, lines: orderedLines };
}

function detectHeadingsTreeHeuristic(
  pageData: Array<{
    pageNumber: number;
    pageHeight: number;
    lines: VisualLine[];
  }>,
  pageCount: number
): ChapterHeading[] {
  const allSizes: number[] = [];
  const lineFreq = new Map<string, Set<number>>();

  for (const p of pageData) {
    for (const l of p.lines) {
      if (l.text.length >= 4 && l.fontSize > 0) {
        allSizes.push(l.fontSize);
      }
      const nearEdge =
        l.y > p.pageHeight * 0.91 || l.y < p.pageHeight * 0.09;
      if (nearEdge && l.text.length <= 80) {
        const key = l.text.toLowerCase();
        if (!lineFreq.has(key)) lineFreq.set(key, new Set());
        lineFreq.get(key)!.add(p.pageNumber);
      }
    }
  }

  const repeatingEdgeLines = new Set<string>();
  for (const [txt, pagesSet] of lineFreq.entries()) {
    if (pagesSet.size >= Math.max(3, Math.floor(pageCount * 0.25))) {
      repeatingEdgeLines.add(txt);
    }
  }

  let medianSize = 11;
  if (allSizes.length > 0) {
    const sorted = [...allSizes].sort((a, b) => a - b);
    medianSize = sorted[Math.floor(sorted.length / 2)];
  }

  const mainPattern =
    /^(chapter\s+[\divx]+|part\s+[\divx]+|unit\s+[\divx]+|section\s+\d+|فصل\s+[\d۰-۹]+|فصل\s+(اول|دوم|سوم|چهارم|پنجم|ششم|هفتم|هشتم|نهم|دهم)|بخش\s+[\d۰-۹]+)\b/i;
  const subPattern = /^(\d+\.\d+(\.\d+)?)\s+[A-Za-z\u0600-\u06FF]/;

  const mainNodes: OutlineTreeDraft[] = [];
  const seenMain = new Set<string>();
  const seenSub = new Set<string>();

  for (const p of pageData) {
    for (const l of p.lines) {
      const text = l.text.replace(/\s+/g, ' ').trim();
      if (text.length < 4 || text.length > 95) continue;
      if (/^[\d۰-۹\s./-]+$/.test(text)) continue;
      if (repeatingEdgeLines.has(text.toLowerCase())) continue;
      if (text.endsWith('.') && !mainPattern.test(text)) continue;

      const isMain =
        l.fontSize >= medianSize * 1.42 ||
        (mainPattern.test(text) && l.fontSize >= medianSize * 1.05);

      const isSub =
        !isMain &&
        (l.fontSize >= medianSize * 1.18 ||
          (subPattern.test(text) && l.fontSize >= medianSize * 0.98));

      if (isMain) {
        const key = `${p.pageNumber}:${text.toLowerCase()}`;
        if (!seenMain.has(key)) {
          seenMain.add(key);
          mainNodes.push({
            title: text,
            level: 0,
            startPage: p.pageNumber,
            children: [],
          });
        }
      } else if (isSub && mainNodes.length > 0) {
        const key = `${p.pageNumber}:${text.toLowerCase()}`;
        if (!seenSub.has(key)) {
          seenSub.add(key);
          mainNodes[mainNodes.length - 1].children.push({
            title: text,
            level: 1,
            startPage: p.pageNumber,
            children: [],
          });
        }
      }
    }
  }

  if (mainNodes.length >= 1) {
    return finalizeTreeRanges(mainNodes.slice(0, 120), pageCount);
  }

  if (pageCount <= 15) {
    return [
      {
        id: 'ch-1',
        title: 'محتوای کتاب',
        level: 0,
        startPage: 1,
        endPage: pageCount,
        children: [],
      },
    ];
  }

  const step = pageCount <= 60 ? 10 : 20;
  const fallback: OutlineTreeDraft[] = [];
  let partIdx = 1;
  for (let start = 1; start <= pageCount; start += step) {
    const end = Math.min(pageCount, start + step - 1);
    fallback.push({
      title: `بخش ${toPersianDigits(partIdx)} (صفحه ${toPersianDigits(start)} تا ${toPersianDigits(end)})`,
      level: 0,
      startPage: start,
      children: [],
    });
    partIdx++;
  }
  return finalizeTreeRanges(fallback, pageCount);
}

export function normalizeChaptersTree(
  chapters: ChapterHeading[]
): ChapterHeading[] {
  if (!chapters || chapters.length === 0) return [];
  const alreadyHierarchical = chapters.some(
    (c) => Array.isArray(c.children) && c.children.length > 0
  );
  if (alreadyHierarchical) {
    return chapters;
  }

  const hasSubLevels = chapters.some((c) => c.level > 0);
  if (!hasSubLevels) {
    return chapters.map((c) => ({ ...c, children: c.children ?? [] }));
  }

  const roots: ChapterHeading[] = [];
  for (const ch of chapters) {
    if (ch.level === 0 || roots.length === 0) {
      roots.push({ ...ch, level: 0, children: [] });
    } else {
      roots[roots.length - 1].children!.push({ ...ch, children: [] });
    }
  }
  return roots;
}

export function findChapterInTree(
  chapters: ChapterHeading[],
  chapterId: string
): ChapterHeading | null {
  for (const ch of chapters) {
    if (ch.id === chapterId) return ch;
    if (ch.children && ch.children.length > 0) {
      const found = findChapterInTree(ch.children, chapterId);
      if (found) return found;
    }
  }
  return null;
}

export function findChapterByPage(
  chapters: ChapterHeading[],
  pageNumber: number
): ChapterHeading | null {
  let matched: ChapterHeading | null = null;
  for (const ch of chapters) {
    if (pageNumber >= ch.startPage && pageNumber <= ch.endPage) {
      matched = ch;
      if (ch.children && ch.children.length > 0) {
        const child = findChapterByPage(ch.children, pageNumber);
        if (child) return child;
      }
    }
  }
  return matched;
}

export function flattenChaptersForPrevNext(
  chapters: ChapterHeading[]
): ChapterHeading[] {
  const flat: ChapterHeading[] = [];
  for (const ch of chapters) {
    flat.push(ch);
    if (ch.children && ch.children.length > 0) {
      flat.push(...flattenChaptersForPrevNext(ch.children));
    }
  }
  return flat;
}

export async function extractAndIndexPdf(
  file: File,
  onProgress?: (pct: number, label: string) => void
): Promise<{
  meta: BookMeta;
  buffer: ArrayBuffer;
  pages: PageTextEntry[];
}> {
  onProgress?.(5, 'در حال خواندن فایل PDF...');
  const buffer = await file.arrayBuffer();
  const { loadingTask, cleanup } = createPdfLoadingTaskFromBuffer(buffer);
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;

  const bookId = `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  onProgress?.(12, 'در حال استخراج سرفصل‌ها...');
  let outlineDraft: OutlineTreeDraft[] = [];
  try {
    const outline = (await pdf.getOutline()) as RawOutlineNode[] | null;
    if (outline && outline.length > 0) {
      const rawDraft = await buildOutlineDraftTree(pdf, outline, 0);
      outlineDraft = unwrapRedundantRootOutline(rawDraft);
    }
  } catch {
    outlineDraft = [];
  }

  const hasOutline = outlineDraft.length > 0;
  const pages: PageTextEntry[] = new Array(pageCount);
  const pageDataForHeuristic: Array<{
    pageNumber: number;
    pageHeight: number;
    lines: VisualLine[];
  }> = hasOutline ? [] : new Array(pageCount);

  // Batch pages concurrently (8 at a time) for dramatically faster offline indexing
  const BATCH_SIZE = 8;
  let processed = 0;

  for (let start = 1; start <= pageCount; start += BATCH_SIZE) {
    const end = Math.min(pageCount, start + BATCH_SIZE - 1);
    const batchNums: number[] = [];
    for (let p = start; p <= end; p++) batchNums.push(p);

    await Promise.all(
      batchNums.map(async (p) => {
        const page = await pdf.getPage(p);
        const textContent = await page.getTextContent();

        if (hasOutline) {
          const rawText = extractFastPageText(textContent.items);
          pages[p - 1] = {
            key: `${bookId}:${p}`,
            bookId,
            pageNumber: p,
            rawText,
            normalizedText: normalizeForSearch(rawText),
          };
        } else {
          const viewport = page.getViewport({ scale: 1 });
          const { rawText, lines } = reconstructPageLinesAndText(
            textContent.items,
            viewport.width
          );
          pages[p - 1] = {
            key: `${bookId}:${p}`,
            bookId,
            pageNumber: p,
            rawText,
            normalizedText: normalizeForSearch(rawText),
          };
          pageDataForHeuristic[p - 1] = {
            pageNumber: p,
            pageHeight: viewport.height,
            lines,
          };
        }
        page.cleanup();
      })
    );

    processed = end;
    const pct = 15 + Math.round((processed / pageCount) * 80);
    onProgress?.(
      pct,
      `در حال فهرست‌سازی صفحه ${toPersianDigits(processed)} از ${toPersianDigits(pageCount)}`
    );
  }

  const chapters: ChapterHeading[] = hasOutline
    ? finalizeTreeRanges(outlineDraft, pageCount)
    : detectHeadingsTreeHeuristic(pageDataForHeuristic, pageCount);

  let title = file.name.replace(/\.pdf$/i, '').trim();
  try {
    const metaInfo = await pdf.getMetadata();
    const infoObj = metaInfo?.info as Record<string, unknown> | undefined;
    const pdfTitle =
      typeof infoObj?.Title === 'string' ? infoObj.Title.trim() : '';
    if (
      pdfTitle &&
      pdfTitle.length >= 3 &&
      !/^(untitled|document|microsoft word)/i.test(pdfTitle)
    ) {
      title = pdfTitle;
    }
  } catch {
    // Keep filename title
  }

  cleanup();
  onProgress?.(100, 'فهرست‌سازی کامل شد');

  const meta: BookMeta = {
    id: bookId,
    title,
    fileName: file.name,
    fileSize: file.size,
    pageCount,
    addedAt: Date.now(),
    chapters,
  };

  return { meta, buffer, pages };
}

function findDeepestChapterWithRoot(
  chapters: ChapterHeading[],
  pageNumber: number,
  rootTitle?: string
): { chapter: ChapterHeading; rootChapterTitle: string; isSubTopic: boolean } | null {
  let matched: {
    chapter: ChapterHeading;
    rootChapterTitle: string;
    isSubTopic: boolean;
  } | null = null;

  for (const ch of chapters) {
    if (pageNumber >= ch.startPage && pageNumber <= ch.endPage) {
      const currentRoot = rootTitle ?? ch.title;
      const isSub = ch.level > 0 || rootTitle !== undefined;
      matched = {
        chapter: ch,
        rootChapterTitle: currentRoot,
        isSubTopic: isSub,
      };
      if (ch.children && ch.children.length > 0) {
        const childMatch = findDeepestChapterWithRoot(
          ch.children,
          pageNumber,
          currentRoot
        );
        if (childMatch) return childMatch;
      }
    }
  }
  return matched;
}

export function searchAcrossBooks(
  books: BookMeta[],
  allPages: PageTextEntry[],
  query: string,
  maxResults = 250
): SearchMatch[] {
  const cleanQuery = query.trim();
  if (cleanQuery.length < 2) return [];

  const normQuery = normalizeForSearch(cleanQuery);
  if (!normQuery) return [];

  const bookMap = new Map<string, BookMeta>();
  for (const b of books) {
    bookMap.set(b.id, {
      ...b,
      chapters: normalizeChaptersTree(b.chapters),
    });
  }

  const seenTopicKey = new Set<string>();
  const matches: SearchMatch[] = [];

  for (let i = 0; i < allPages.length; i++) {
    const page = allPages[i];
    const hitIdx = page.normalizedText.indexOf(normQuery);
    if (hitIdx === -1) continue;

    const book = bookMap.get(page.bookId);
    if (!book) continue;

    const resolved = findDeepestChapterWithRoot(book.chapters, page.pageNumber);
    const chapter = resolved?.chapter ??
      book.chapters[0] ?? {
        id: 'ch-1',
        title: book.title,
        level: 0,
        startPage: page.pageNumber,
        endPage: page.pageNumber,
      };
    const rootChapterTitle = resolved?.rootChapterTitle ?? chapter.title;
    const isSubTopic = resolved?.isSubTopic ?? false;

    // Exclude References / Bibliography / Index headings from appearing as search topics
    if (
      isReferenceHeading(chapter.title) ||
      isReferenceHeading(rootChapterTitle)
    ) {
      continue;
    }

    const dedupKey = `${book.id}:${chapter.id}`;
    if (seenTopicKey.has(dedupKey)) continue;
    seenTopicKey.add(dedupKey);

    const { topic, score } = classifyClinicalTopic({
      chapterTitle: `${rootChapterTitle} ${chapter.title}`,
      rawPageText: page.rawText,
      matchStart: Math.min(hitIdx, Math.max(0, page.rawText.length - 1)),
    });

    matches.push({
      id: `${book.id}-${chapter.id}-${page.pageNumber}`,
      bookId: book.id,
      bookTitle: book.title,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      rootChapterTitle,
      isSubTopic,
      pageNumber: page.pageNumber,
      topic,
      matchedTerm: cleanQuery,
      score,
    });

    if (matches.length >= maxResults) break;
  }

  // Sort strictly: Main Topics before Sub-topics, then by clinical priority
  matches.sort((a, b) => {
    if (a.isSubTopic !== b.isSubTopic) {
      return a.isSubTopic ? 1 : -1;
    }
    const prioDiff = getTopicPriority(a.topic) - getTopicPriority(b.topic);
    if (prioDiff !== 0) return prioDiff;
    if (b.score !== a.score) return b.score - a.score;
    return a.pageNumber - b.pageNumber;
  });

  return matches;
}

function extractCompactPreview(
  rawText: string,
  query: string
): { before: string; match: string; after: string } {
  const ranges = findMatchRangesInRawText(rawText, query);
  const range = ranges[0];
  if (!range) {
    return {
      before: rawText.slice(0, 120).replace(/\s+/g, ' ').trim(),
      match: '',
      after: '',
    };
  }
  const ctxBefore = 42;
  const ctxAfter = 78;
  const start = Math.max(0, range.start - ctxBefore);
  const end = Math.min(rawText.length, range.end + ctxAfter);

  const prefix = start > 0 ? '...' : '';
  const suffix = end < rawText.length ? '...' : '';

  return {
    before: `${prefix}${rawText.slice(start, range.start).replace(/\s+/g, ' ')}`,
    match: rawText.slice(range.start, range.end).replace(/\s+/g, ' '),
    after: `${rawText.slice(range.end, end).replace(/\s+/g, ' ')}${suffix}`,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  let count = 0;
  let pos = 0;
  const step = Math.max(1, needle.length);
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += step;
  }
  return count;
}

function findCoveringSubTopics(
  children: ChapterHeading[],
  pageNumber: number,
  parentTitle?: string
): Array<{ node: ChapterHeading; parentTitle?: string }> {
  const hits: Array<{ node: ChapterHeading; parentTitle?: string }> = [];
  for (const child of children) {
    if (pageNumber >= child.startPage && pageNumber <= child.endPage) {
      const nestedHits =
        child.children && child.children.length > 0
          ? findCoveringSubTopics(child.children, pageNumber, child.title)
          : [];
      if (nestedHits.length > 0) {
        hits.push(...nestedHits);
      } else {
        hits.push({ node: child, parentTitle });
      }
    }
  }
  return hits;
}

const INLINE_HEADING_PATTERN =
  /^(treatment|management|therapy|disposition|admission|discharge|follow[\s-]?up|diagnosis|diagnostic(\s+(evaluation|strategies|testing|approach|workup))?|differential\s+diagnosis|clinical\s+(features|manifestations|presentation|findings)|signs\s+and\s+symptoms|symptoms|physical\s+exam(ination)?|history|pathophysiology|etiology|epidemiology|pathogenesis|complications|prognosis|prevention|key\s+concepts|perspectives|principles\s+of\s+disease|special\s+(populations|considerations)|emergency\s+management|initial\s+(stabilization|management|assessment)|درمان|مدیریت\s+بیمار|دیسپوزیشن|ترخیص|بستری|پیگیری|ارزیابی\s+تشخیصی|تشخیص(\s+افتراقی)?|علا[ئ|ی]م\s+بالینی|تظاهرات\s+بالینی|معاینه\s+بالینی|شرح\s+حال|پاتوفیزیولوژی|اتیولوژی|اپیدمیولوژی|عوارض|پیش‌آگهی)\b/i;

function isPlausibleInlineHeading(line: string): boolean {
  const clean = line.replace(/\s+/g, ' ').trim();
  if (clean.length < 4 || clean.length > 68) return false;
  if (isReferenceHeading(clean)) return false;
  if (/^[\d۰-۹.\-–—\s/()]+$/.test(clean)) return false;
  if (/^(fig(\.|ure)?|table|box|chapter|section)\s+\d/i.test(clean)) return false;
  if (/[.!؟?،,;:]$/.test(clean) && !INLINE_HEADING_PATTERN.test(clean)) return false;

  if (INLINE_HEADING_PATTERN.test(clean)) return true;

  // ALL CAPS headings (common in Rosen's / Tintinalli's PDFs)
  const lettersOnly = clean.replace(/[^A-Za-z]/g, '');
  if (
    lettersOnly.length >= 5 &&
    lettersOnly === lettersOnly.toUpperCase() &&
    clean.split(/\s+/).length <= 7
  ) {
    return true;
  }

  return false;
}

function extractInlineSubHeadingHits(
  rawText: string,
  normQuery: string,
  chapterId: string
): Array<{ id: string; title: string; occurrences: number }> {
  const lines = rawText.split(/\r?\n/);
  let currentHeading: string | null = null;
  const counts = new Map<string, number>();

  for (const rawLine of lines) {
    const trimmed = rawLine.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;

    if (isPlausibleInlineHeading(trimmed)) {
      currentHeading = trimmed;
    }

    const normLine = normalizeForSearch(trimmed);
    const hits = countOccurrences(normLine, normQuery);
    if (hits > 0 && currentHeading) {
      counts.set(currentHeading, (counts.get(currentHeading) ?? 0) + hits);
    }
  }

  const out: Array<{ id: string; title: string; occurrences: number }> = [];
  for (const [title, occurrences] of counts.entries()) {
    const slug = normalizeForSearch(title)
      .replace(/[^a-z0-9\u0600-\u06ff]+/g, '-')
      .slice(0, 40);
    out.push({
      id: `${chapterId}-sec-${slug}`,
      title,
      occurrences,
    });
  }
  return out;
}

function findRootChapterForPage(
  chapters: ChapterHeading[],
  pageNumber: number
): ChapterHeading | null {
  let rootChapter: ChapterHeading | null = null;
  for (const ch of chapters) {
    if (pageNumber >= ch.startPage && pageNumber <= ch.endPage) {
      rootChapter = ch;
    }
  }
  return rootChapter;
}

export function searchChaptersAcrossBooks(
  books: BookMeta[],
  allPages: PageTextEntry[],
  query: string
): ChapterSearchGroup[] {
  const cleanQuery = query.trim();
  if (cleanQuery.length < 2) return [];

  const normQuery = normalizeForSearch(cleanQuery);
  if (!normQuery) return [];

  const bookMap = new Map<string, BookMeta>();
  for (const b of books) {
    bookMap.set(b.id, {
      ...b,
      chapters: normalizeChaptersTree(b.chapters),
    });
  }

  interface SubDraft {
    id: string;
    chapterId: string;
    title: string;
    parentTitle?: string;
    bestPageNumber: number;
    bestPageRawText: string;
    bestPageRank: number;
    topic: SubTopicSearchHit['topic'];
    score: number;
    occurrenceCount: number;
    titleMatches: boolean;
  }

  interface GroupDraft {
    id: string;
    bookId: string;
    bookTitle: string;
    chapterId: string;
    chapterTitle: string;
    bestPageNumber: number;
    bestPageRawText: string;
    bestPageRank: number;
    bestTopic: ChapterSearchGroup['bestTopic'];
    bestScore: number;
    totalOccurrences: number;
    titleMatches: boolean;
    subMap: Map<string, SubDraft>;
  }

  const groupMap = new Map<string, GroupDraft>();

  for (let i = 0; i < allPages.length; i++) {
    const page = allPages[i];
    const hitIdx = page.normalizedText.indexOf(normQuery);
    if (hitIdx === -1) continue;

    const book = bookMap.get(page.bookId);
    if (!book) continue;

    const rootChapter =
      findRootChapterForPage(book.chapters, page.pageNumber) ??
      book.chapters[0] ?? {
        id: 'ch-1',
        title: book.title,
        level: 0,
        startPage: page.pageNumber,
        endPage: page.pageNumber,
        children: [],
      };

    if (isReferenceHeading(rootChapter.title)) continue;

    const outlineSubs =
      rootChapter.children && rootChapter.children.length > 0
        ? findCoveringSubTopics(rootChapter.children, page.pageNumber)
        : [];

    // If this page belongs to a References / Bibliography sub-topic, skip the entire page
    if (outlineSubs.some((s) => isReferenceHeading(s.node.title))) continue;

    // Exclude full Reference pages and strip trailing References section from mixed pages
    const cleanRawText = getSearchableNonReferenceText(page.rawText);
    if (!cleanRawText) continue;

    const cleanNormalizedText =
      cleanRawText === page.rawText
        ? page.normalizedText
        : normalizeForSearch(cleanRawText);

    const cleanHitIdx = cleanNormalizedText.indexOf(normQuery);
    if (cleanHitIdx === -1) continue;

    const pageOccurrences = countOccurrences(cleanNormalizedText, normQuery);
    if (pageOccurrences === 0) continue;

    const validOutlineSubs = outlineSubs;

    const primarySubTitle = validOutlineSubs[0]?.node.title ?? '';
    const { topic, score } = classifyClinicalTopic({
      chapterTitle: `${rootChapter.title} ${primarySubTitle}`,
      rawPageText: cleanRawText,
      matchStart: Math.min(cleanHitIdx, Math.max(0, cleanRawText.length - 1)),
    });

    const prio = getTopicPriority(topic);
    const pageRank = pageOccurrences * 25 + (7 - prio) * 4 + score;

    const groupKey = `${book.id}:${rootChapter.id}`;
    let group = groupMap.get(groupKey);

    if (!group) {
      const titleMatches = normalizeForSearch(rootChapter.title).includes(normQuery);
      group = {
        id: groupKey,
        bookId: book.id,
        bookTitle: book.title,
        chapterId: rootChapter.id,
        chapterTitle: rootChapter.title,
        bestPageNumber: page.pageNumber,
        bestPageRawText: cleanRawText,
        bestPageRank: pageRank,
        bestTopic: topic,
        bestScore: score,
        totalOccurrences: pageOccurrences,
        titleMatches,
        subMap: new Map(),
      };
      groupMap.set(groupKey, group);
    } else {
      group.totalOccurrences += pageOccurrences;
      if (pageRank > group.bestPageRank) {
        group.bestPageNumber = page.pageNumber;
        group.bestPageRawText = cleanRawText;
        group.bestPageRank = pageRank;
        group.bestTopic = topic;
        group.bestScore = score;
      }
    }

    if (validOutlineSubs.length > 0) {
      for (const { node: subNode, parentTitle } of validOutlineSubs) {
        if (subNode.id === rootChapter.id) continue;
        const subClass = classifyClinicalTopic({
          chapterTitle: `${parentTitle ?? ''} ${subNode.title}`,
          rawPageText: cleanRawText,
          matchStart: Math.min(cleanHitIdx, Math.max(0, cleanRawText.length - 1)),
        });
        const subPrio = getTopicPriority(subClass.topic);
        const subTitleMatch = normalizeForSearch(subNode.title).includes(normQuery);
        const subPageRank =
          pageOccurrences * 25 + (7 - subPrio) * 5 + subClass.score;

        const existingSub = group.subMap.get(subNode.id);
        if (!existingSub) {
          group.subMap.set(subNode.id, {
            id: `${groupKey}:${subNode.id}`,
            chapterId: subNode.id,
            title: subNode.title,
            parentTitle,
            bestPageNumber: page.pageNumber,
            bestPageRawText: cleanRawText,
            bestPageRank: subPageRank,
            topic: subClass.topic,
            score: subClass.score,
            occurrenceCount: pageOccurrences,
            titleMatches: subTitleMatch,
          });
        } else {
          existingSub.occurrenceCount += pageOccurrences;
          if (subPageRank > existingSub.bestPageRank) {
            existingSub.bestPageNumber = page.pageNumber;
            existingSub.bestPageRawText = cleanRawText;
            existingSub.bestPageRank = subPageRank;
            existingSub.topic = subClass.topic;
            existingSub.score = subClass.score;
          }
        }
      }
    } else if (!rootChapter.children || rootChapter.children.length === 0) {
      // Fallback: synthesize real in-page sub-headings when the PDF has chapter-only bookmarks
      const inlineHits = extractInlineSubHeadingHits(
        cleanRawText,
        normQuery,
        rootChapter.id
      );
      for (const ih of inlineHits) {
        const subClass = classifyClinicalTopic({
          chapterTitle: ih.title,
          rawPageText: cleanRawText,
          matchStart: Math.min(cleanHitIdx, Math.max(0, cleanRawText.length - 1)),
        });
        const subPrio = getTopicPriority(subClass.topic);
        const subTitleMatch = normalizeForSearch(ih.title).includes(normQuery);
        const subPageRank = ih.occurrences * 25 + (7 - subPrio) * 5 + subClass.score;

        const existingSub = group.subMap.get(ih.id);
        if (!existingSub) {
          group.subMap.set(ih.id, {
            id: `${groupKey}:${ih.id}`,
            chapterId: rootChapter.id,
            title: ih.title,
            bestPageNumber: page.pageNumber,
            bestPageRawText: cleanRawText,
            bestPageRank: subPageRank,
            topic: subClass.topic,
            score: subClass.score,
            occurrenceCount: ih.occurrences,
            titleMatches: subTitleMatch,
          });
        } else {
          existingSub.occurrenceCount += ih.occurrences;
          if (subPageRank > existingSub.bestPageRank) {
            existingSub.bestPageNumber = page.pageNumber;
            existingSub.bestPageRawText = cleanRawText;
            existingSub.bestPageRank = subPageRank;
            existingSub.topic = subClass.topic;
            existingSub.score = subClass.score;
          }
        }
      }
    }
  }

  const results: ChapterSearchGroup[] = [];
  for (const g of groupMap.values()) {
    const subs: SubTopicSearchHit[] = Array.from(g.subMap.values())
      .sort((a, b) => {
        const pDiff = getTopicPriority(a.topic) - getTopicPriority(b.topic);
        if (pDiff !== 0) return pDiff;
        if (a.titleMatches !== b.titleMatches) return a.titleMatches ? -1 : 1;
        if (b.occurrenceCount !== a.occurrenceCount) {
          return b.occurrenceCount - a.occurrenceCount;
        }
        if (b.score !== a.score) return b.score - a.score;
        return a.bestPageNumber - b.bestPageNumber;
      })
      .map((s) => {
        const subPreview = extractCompactPreview(s.bestPageRawText, cleanQuery);
        return {
          id: s.id,
          chapterId: s.chapterId,
          title: s.title,
          parentTitle: s.parentTitle,
          pageNumber: s.bestPageNumber,
          topic: s.topic,
          score: s.score,
          occurrenceCount: s.occurrenceCount,
          titleMatches: s.titleMatches,
          previewBefore: subPreview.before,
          previewMatch: subPreview.match,
          previewAfter: subPreview.after,
        };
      });

    const preview = extractCompactPreview(g.bestPageRawText, cleanQuery);
    results.push({
      id: g.id,
      bookId: g.bookId,
      bookTitle: g.bookTitle,
      chapterId: g.chapterId,
      chapterTitle: g.chapterTitle,
      bestPageNumber: g.bestPageNumber,
      bestTopic: g.bestTopic,
      bestScore: g.bestScore,
      totalOccurrences: g.totalOccurrences,
      titleMatches: g.titleMatches,
      previewBefore: preview.before,
      previewMatch: preview.match,
      previewAfter: preview.after,
      matchingSubTopics: subs,
    });
  }

  // Sort chapters strictly by relevance: title match, then total term occurrences in the chapter, then clinical priority
  results.sort((a, b) => {
    if (a.titleMatches !== b.titleMatches) return a.titleMatches ? -1 : 1;
    if (b.totalOccurrences !== a.totalOccurrences) {
      return b.totalOccurrences - a.totalOccurrences;
    }
    const pDiff = getTopicPriority(a.bestTopic) - getTopicPriority(b.bestTopic);
    if (pDiff !== 0) return pDiff;
    if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
    return a.bestPageNumber - b.bestPageNumber;
  });

  return results;
}
