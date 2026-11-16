const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/**
 * Normalizes Persian/Arabic variants (ي->ی, ك->ک, diacritics, half-space/digits)
 * strictly for indexing and search queries. Never alters displayed PDF text.
 */
export function normalizeForSearch(input: string): string {
  if (!input) return '';
  return input
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '') // Arabic diacritics
    .replace(/\u064A/g, '\u06CC') // Arabic Yeh -> Persian Yeh
    .replace(/\u0649/g, '\u06CC') // Alef Maksura -> Persian Yeh
    .replace(/\u0643/g, '\u06A9') // Arabic Kaf -> Persian Kaf
    .replace(/\u0629/g, '\u0647') // Teh Marbuta -> Heh
    .replace(/[\u0622\u0623\u0625]/g, '\u0627') // Alef variants -> Alef
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u200C/g, ' ') // ZWNJ -> space for flexible matching
    .toLowerCase();
}

/**
 * Formats numbers using Persian numerals for UI labels while preserving tabular readability.
 */
export function toPersianDigits(value: number | string): string {
  return String(value).replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

export function formatFileSizeFa(bytes: number): string {
  if (bytes < 1024) return `${toPersianDigits(bytes)} بایت`;
  if (bytes < 1024 * 1024) {
    return `${toPersianDigits((bytes / 1024).toFixed(0))} کیلوبایت`;
  }
  return `${toPersianDigits((bytes / (1024 * 1024)).toFixed(1))} مگابایت`;
}

function normalizeSingleChar(ch: string): string {
  const code = ch.charCodeAt(0);
  // Fast ASCII path
  if (code < 128) {
    return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : ch;
  }
  // Arabic diacritics
  if (
    (code >= 0x064b && code <= 0x065f) ||
    code === 0x0670 ||
    (code >= 0x06d6 && code <= 0x06ed)
  ) {
    return '';
  }
  if (code === 0x064a || code === 0x0649) return '\u06cc';
  if (code === 0x0643) return '\u06a9';
  if (code === 0x0629) return '\u0647';
  if (code === 0x0622 || code === 0x0623 || code === 0x0625) return '\u0627';
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code === 0x200c) return ' ';
  return ch.toLowerCase();
}

/**
 * Finds all match ranges inside `rawText` by normalizing character-by-character
 * and mapping indices back to the original unmodified `rawText`.
 */
export function findMatchRangesInRawText(
  rawText: string,
  query: string
): Array<{ start: number; end: number }> {
  const normQuery = normalizeForSearch(query).trim();
  if (!normQuery || !rawText) return [];

  // Build normalized string with single-pass O(n) character index mapping
  let normStr = '';
  const indexMap: number[] = [];

  for (let i = 0; i < rawText.length; i++) {
    const normCh = normalizeSingleChar(rawText[i]);
    if (normCh.length === 0) continue;
    for (let j = 0; j < normCh.length; j++) {
      normStr += normCh[j];
      indexMap.push(i);
    }
  }

  const ranges: Array<{ start: number; end: number }> = [];
  let searchFrom = 0;
  while (searchFrom <= normStr.length - normQuery.length) {
    const idx = normStr.indexOf(normQuery, searchFrom);
    if (idx === -1) break;
    const rawStart = indexMap[idx];
    const rawEnd = indexMap[idx + normQuery.length - 1] + 1;
    ranges.push({ start: rawStart, end: rawEnd });
    searchFrom = idx + Math.max(1, normQuery.length);
  }

  return ranges;
}
