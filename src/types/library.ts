export interface ChapterHeading {
  id: string;
  title: string;
  level: number;
  startPage: number;
  endPage: number;
  children?: ChapterHeading[];
}

export interface BookMeta {
  id: string;
  title: string;
  fileName: string;
  fileSize: number;
  pageCount: number;
  addedAt: number;
  chapters: ChapterHeading[];
}

export interface PageTextEntry {
  key: string; // `${bookId}:${pageNumber}`
  bookId: string;
  pageNumber: number;
  rawText: string;
  normalizedText: string;
}

export type ClinicalTopicKey =
  | 'treatment'
  | 'disposition'
  | 'diagnostic'
  | 'clinical_signs'
  | 'pathophysiology'
  | 'other';

export interface TopicDefinition {
  key: ClinicalTopicKey;
  label: string;
  priority: number;
}

/**
 * Exact clinical priority order:
 * 1. درمان (Treatment)
 * 2. دیسپوزیشن (Disposition)
 * 3. ارزیابی تشخیصی (Diagnostic Evaluation)
 * 4. علایم بالینی (Clinical Manifestations)
 * 5. پاتوفیزیولوژی (Pathophysiology)
 * 6. سایر مباحث (Other fallback)
 */
export const CLINICAL_TOPICS: TopicDefinition[] = [
  { key: 'treatment', label: 'درمان', priority: 1 },
  { key: 'disposition', label: 'دیسپوزیشن', priority: 2 },
  { key: 'diagnostic', label: 'ارزیابی تشخیصی', priority: 3 },
  { key: 'clinical_signs', label: 'علایم بالینی', priority: 4 },
  { key: 'pathophysiology', label: 'پاتوفیزیولوژی', priority: 5 },
  { key: 'other', label: 'سایر مباحث', priority: 6 },
];

export interface SearchMatch {
  id: string;
  bookId: string;
  bookTitle: string;
  chapterId: string;
  chapterTitle: string;
  rootChapterTitle: string;
  isSubTopic: boolean;
  pageNumber: number;
  topic: ClinicalTopicKey;
  matchedTerm: string;
  score: number;
}

export interface SubTopicSearchHit {
  id: string;
  chapterId: string;
  title: string;
  parentTitle?: string;
  pageNumber: number;
  topic: ClinicalTopicKey;
  score: number;
  occurrenceCount: number;
  titleMatches: boolean;
  previewBefore: string;
  previewMatch: string;
  previewAfter: string;
}

export interface ChapterSearchGroup {
  id: string;
  bookId: string;
  bookTitle: string;
  chapterId: string;
  chapterTitle: string;
  bestPageNumber: number;
  bestTopic: ClinicalTopicKey;
  bestScore: number;
  totalOccurrences: number;
  titleMatches: boolean;
  previewBefore: string;
  previewMatch: string;
  previewAfter: string;
  matchingSubTopics: SubTopicSearchHit[];
}

export type AppTab = 'library' | 'search';
