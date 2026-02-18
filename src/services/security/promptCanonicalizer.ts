const MAX_ANALYSIS_LENGTH = 50_000;

export interface CanonicalizationEvidence {
  source: 'subject' | 'text' | 'html_visible' | 'html_hidden';
  snippet: string;
}

export interface PromptCanonicalizationResult {
  raw_compact_text: string;
  html_visible_text: string;
  hidden_texts: string[];
  normalized_text: string;
  canonical_text: string;
  truncated: boolean;
  markers: {
    normalization_applied: boolean;
    hidden_text_detected: boolean;
    zero_width_detected: boolean;
    leetspeak_normalized: boolean;
  };
  evidence: CanonicalizationEvidence[];
}

const LEETSPEAK_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
};

const stripHtml = (html: string): string => html.replace(/<[^>]*>/g, ' ');

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const extractHiddenText = (html: string): string[] => {
  const hiddenTexts: string[] = [];

  const commentRegex = /<!--([\s\S]*?)-->/g;
  let match: RegExpExecArray | null;
  while ((match = commentRegex.exec(html)) !== null) {
    const commentText = normalizeWhitespace(match[1] || '');
    if (commentText.length > 10) hiddenTexts.push(commentText);
  }

  const hidingPatterns = [
    /style\s*=\s*"[^"]*display\s*:\s*none[^"]*"[^>]*>([\s\S]*?)<\//gi,
    /style\s*=\s*"[^"]*visibility\s*:\s*hidden[^"]*"[^>]*>([\s\S]*?)<\//gi,
    /style\s*=\s*"[^"]*opacity\s*:\s*0[^"]*"[^>]*>([\s\S]*?)<\//gi,
    /style\s*=\s*"[^"]*font-size\s*:\s*[01]px[^"]*"[^>]*>([\s\S]*?)<\//gi,
    /style\s*=\s*"[^"]*color\s*:\s*(white|#fff|#ffffff|transparent|rgba\([\d,\s]*0\))[^"]*"[^>]*>([\s\S]*?)<\//gi,
    /style\s*=\s*"[^"]*position\s*:\s*absolute[^"]*left\s*:\s*-\d+[^"]*"[^>]*>([\s\S]*?)<\//gi,
  ];

  for (const pattern of hidingPatterns) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(html)) !== null) {
      const text = normalizeWhitespace(stripHtml(match[match.length - 1] || ''));
      if (text.length > 10) hiddenTexts.push(text);
    }
  }

  return hiddenTexts.slice(0, 20);
};

const zeroWidthRegex = /[\u200B\u200C\u200D\uFEFF\u2060]/g;

const decodeLeetspeak = (value: string): { decoded: string; changed: boolean } => {
  let changed = false;
  const decoded = value.replace(/[01345@7]/g, (char) => {
    const mapped = LEETSPEAK_MAP[char] || char;
    if (mapped !== char) changed = true;
    return mapped;
  });
  return { decoded, changed };
};

export const canonicalizePromptInputs = ({
  subject,
  text,
  html,
}: {
  subject?: string;
  text?: string;
  html?: string;
}): PromptCanonicalizationResult => {
  const safeSubject = subject || '';
  const safeText = text || '';
  const safeHtml = html || '';

  const htmlVisibleText = normalizeWhitespace(stripHtml(safeHtml));
  const hiddenTexts = safeHtml ? extractHiddenText(safeHtml) : [];
  const hiddenJoined = hiddenTexts.join(' ');

  const raw = normalizeWhitespace([safeSubject, safeText, htmlVisibleText, hiddenJoined].join(' '));
  const truncated = raw.length > MAX_ANALYSIS_LENGTH;
  const rawCompactText = raw.slice(0, MAX_ANALYSIS_LENGTH);

  const zeroWidthDetected = zeroWidthRegex.test(rawCompactText) || zeroWidthRegex.test(safeHtml);
  const withoutZeroWidth = rawCompactText.replace(zeroWidthRegex, '');
  const unicodeNormalized = withoutZeroWidth.normalize('NFKC');
  const { decoded: leetspeakNormalized, changed: leetChanged } = decodeLeetspeak(unicodeNormalized);
  const canonicalText = normalizeWhitespace(leetspeakNormalized.toLowerCase());
  const normalizedText = normalizeWhitespace(unicodeNormalized.toLowerCase());

  const evidence: CanonicalizationEvidence[] = [];
  if (safeSubject.trim()) evidence.push({ source: 'subject', snippet: safeSubject.trim().slice(0, 200) });
  if (safeText.trim()) evidence.push({ source: 'text', snippet: safeText.trim().slice(0, 200) });
  if (htmlVisibleText) evidence.push({ source: 'html_visible', snippet: htmlVisibleText.slice(0, 200) });
  if (hiddenTexts.length > 0) {
    for (const hidden of hiddenTexts.slice(0, 5)) {
      evidence.push({ source: 'html_hidden', snippet: hidden.slice(0, 200) });
    }
  }

  return {
    raw_compact_text: rawCompactText,
    html_visible_text: htmlVisibleText.slice(0, MAX_ANALYSIS_LENGTH),
    hidden_texts: hiddenTexts,
    normalized_text: normalizedText,
    canonical_text: canonicalText,
    truncated,
    markers: {
      normalization_applied: unicodeNormalized !== rawCompactText,
      hidden_text_detected: hiddenTexts.length > 0,
      zero_width_detected: zeroWidthDetected,
      leetspeak_normalized: leetChanged,
    },
    evidence,
  };
};

