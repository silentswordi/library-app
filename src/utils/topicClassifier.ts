import { CLINICAL_TOPICS, ClinicalTopicKey } from '../types/library';
import { normalizeForSearch } from './arabicNormalize';

const TOPIC_KEYWORDS: Record<Exclude<ClinicalTopicKey, 'other'>, string[]> = {
  treatment: [
    'درمان',
    'تراپی',
    'مدیریت',
    'تجویز',
    'دارو',
    'دوز',
    'دوزاژ',
    'جراحی',
    'آنتی‌بیوتیک',
    'انتی‌بیوتیک',
    'انتی بیوتیک',
    'پروسیجر',
    'احیا',
    'پروتکل درمانی',
    'اقدامات درمانی',
    'درمان دارویی',
    'درمان اورژانسی',
    'treatment',
    'therapy',
    'therapeutic',
    'management',
    'pharmacotherapy',
    'medication',
    'regimen',
    'dosage',
    'dose',
    'administer',
    'antibiotic',
    'resuscitation',
    'intervention',
    'surgery',
    'surgical',
    'stabilization',
    'analgesia',
    'antidote',
  ],
  disposition: [
    'دیسپوزیشن',
    'ترخیص',
    'بستری',
    'آی‌سی‌یو',
    'ای سی یو',
    'مراقبت ویژه',
    'بخش ویژه',
    'ارجاع',
    'پیگیری',
    'مشاوره',
    'انتقال',
    'تعیین تکلیف',
    'شرایط ترخیص',
    'اندیکاسیون بستری',
    'disposition',
    'discharge',
    'admission',
    'admit',
    'hospitalization',
    'hospitalize',
    'icu',
    'intensive care',
    'follow-up',
    'followup',
    'outpatient',
    'inpatient',
    'transfer',
    'referral',
    'consult',
    'observation unit',
  ],
  diagnostic: [
    'ارزیابی تشخیصی',
    'تشخیص',
    'تشخیصی',
    'تشخیص افتراقی',
    'آزمایش',
    'آزمایشات',
    'تست',
    'تصویربرداری',
    'سونوگرافی',
    'سی‌تی',
    'سی تی',
    'ام‌آرآی',
    'ام آر آی',
    'رادیوگرافی',
    'گرافی',
    'بیوپسی',
    'نوار قلب',
    'اکوکاردیوگرافی',
    'معیار تشخیصی',
    'ارزیابی اولیه',
    'diagnostic',
    'diagnosis',
    'diagnoses',
    'differential diagnosis',
    'evaluation',
    'workup',
    'work-up',
    'laboratory',
    'imaging',
    'radiograph',
    'x-ray',
    'ultrasound',
    'sonography',
    'ct scan',
    'computed tomography',
    'mri',
    'biopsy',
    'ecg',
    'ekg',
    'echocardiography',
    'biomarker',
    'assay',
    'screening',
    'criteria',
  ],
  clinical_signs: [
    'علایم بالینی',
    'علائم بالینی',
    'تظاهرات بالینی',
    'علایم',
    'علائم',
    'نشانه',
    'نشانه‌ها',
    'معاینه',
    'معاینه فیزیکی',
    'شرح حال',
    'شکایت اصلی',
    'تظاهر بالینی',
    'سندرم بالینی',
    'یافته‌های بالینی',
    'clinical manifestations',
    'clinical features',
    'clinical presentation',
    'signs and symptoms',
    'symptoms',
    'signs',
    'physical examination',
    'physical exam',
    'presentation',
    'clinical findings',
    'history and physical',
    'chief complaint',
    'symptomatology',
    'semiology',
  ],
  pathophysiology: [
    'پاتوفیزیولوژی',
    'فیزیوپاتولوژی',
    'پاتوژنز',
    'مکانیسم',
    'اتیولوژی',
    'سبب‌شناسی',
    'بافت‌شناسی',
    'پاتولوژی',
    'ایمونوپاتولوژی',
    'مکانیسم بیماری',
    'بیماری‌زایی',
    'pathophysiology',
    'physiopathology',
    'pathogenesis',
    'etiology',
    'aetiology',
    'mechanism',
    'histology',
    'histopathology',
    'molecular',
    'cascade',
    'pathology',
  ],
};

/**
 * Classifies a matched text location into one of the 5 prioritized clinical topics
 * (or 'other') by inspecting local heading lines, chapter title, and surrounding context.
 */
export function classifyClinicalTopic(params: {
  chapterTitle: string;
  rawPageText: string;
  matchStart: number;
}): { topic: ClinicalTopicKey; score: number } {
  const { chapterTitle, rawPageText, matchStart } = params;

  // Extract context window before & around the match to identify local sub-headings
  const lookbackStart = Math.max(0, matchStart - 450);
  const lookaheadEnd = Math.min(rawPageText.length, matchStart + 250);
  const precedingWindow = rawPageText.slice(lookbackStart, matchStart);
  const localWindow = rawPageText.slice(
    Math.max(0, matchStart - 220),
    lookaheadEnd
  );

  // Find the nearest heading-like short line above the match
  const linesBefore = precedingWindow
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.length <= 90);
  const nearestHeading = linesBefore.slice(-3).join(' ');

  const normHeading = normalizeForSearch(nearestHeading);
  const normChapter = normalizeForSearch(chapterTitle);
  const normLocal = normalizeForSearch(localWindow);

  const scores: Record<Exclude<ClinicalTopicKey, 'other'>, number> = {
    treatment: 0,
    disposition: 0,
    diagnostic: 0,
    clinical_signs: 0,
    pathophysiology: 0,
  };

  for (const topicKey of Object.keys(TOPIC_KEYWORDS) as Array<
    Exclude<ClinicalTopicKey, 'other'>
  >) {
    for (const kw of TOPIC_KEYWORDS[topicKey]) {
      const normKw = normalizeForSearch(kw);
      if (!normKw) continue;
      if (normChapter.includes(normKw)) {
        scores[topicKey] += 24;
      }
      if (normHeading.includes(normKw)) {
        scores[topicKey] += 10;
      }
      if (normLocal.includes(normKw)) {
        scores[topicKey] += 3;
      }
    }
  }

  let bestTopic: ClinicalTopicKey = 'other';
  let bestScore = 0;

  // Iterate in exact priority order so ties break according to user's clinical priority
  for (const def of CLINICAL_TOPICS) {
    if (def.key === 'other') continue;
    const sc = scores[def.key];
    if (sc > bestScore) {
      bestScore = sc;
      bestTopic = def.key;
    }
  }

  return { topic: bestTopic, score: bestScore };
}

export function getTopicPriority(topic: ClinicalTopicKey): number {
  return CLINICAL_TOPICS.find((t) => t.key === topic)?.priority ?? 99;
}

export function getTopicLabel(topic: ClinicalTopicKey): string {
  return CLINICAL_TOPICS.find((t) => t.key === topic)?.label ?? 'سایر مباحث';
}
