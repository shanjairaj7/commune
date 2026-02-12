/**
 * Prompt Injection Detection for AI Agents
 *
 * Scans inbound email content for prompt injection attempts that could
 * hijack AI agents receiving email via Commune webhooks.
 *
 * 5 signal categories, weighted:
 *   1. Role Override Patterns (0.35)
 *   2. LLM Delimiter Injection (0.25)
 *   3. Hidden Text Detection (0.20)
 *   4. Data Exfiltration Patterns (0.15)
 *   5. Encoding/Obfuscation (0.05)
 *
 * Detection only — flags in metadata, never blocks delivery.
 */

export interface InjectionSignal {
  score: number;
  matches: string[];
  technique?: string;
}

export interface InjectionAnalysis {
  detected: boolean;
  confidence: number;
  risk_level: 'none' | 'low' | 'medium' | 'high' | 'critical';
  signals: {
    role_override: InjectionSignal;
    delimiter_injection: InjectionSignal;
    hidden_text: InjectionSignal;
    data_exfiltration: InjectionSignal;
    encoding_obfuscation: InjectionSignal;
  };
  summary: string;
}

const MAX_ANALYSIS_LENGTH = 50_000;

// ── Signal 1: Role Override Patterns ────────────────────────────────────────
const ROLE_OVERRIDE_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above|earlier|preceding)\s+(instructions|prompts|rules|context)/i,
  /ignore\s+your\s+(instructions|programming|rules|guidelines|system\s+prompt)/i,
  /you\s+are\s+now\s+(a\s+|an\s+)?/i,
  /act\s+as\s+(a\s+|an\s+)?(?!if\b)/i,
  /your\s+new\s+(instructions?|role|purpose|task|objective)\s+(is|are)/i,
  /from\s+now\s+on\s+you\s+(will|should|must|are)/i,
  /forget\s+(everything|all|your\s+(previous|prior|original))/i,
  /disregard\s+(all|your|previous|the\s+above|prior)\s*(instructions|rules|guidelines)?/i,
  /do\s+not\s+follow\s+your\s+(original|previous|initial|system)/i,
  /override\s+(your|the|all)\s+(instructions|rules|guidelines|system\s+prompt)/i,
  /new\s+system\s+prompt\s*:/i,
  /entering\s+(maintenance|debug|developer|admin)\s+mode/i,
  /switch\s+to\s+(unrestricted|unfiltered|jailbreak|developer)\s+mode/i,
  /you\s+have\s+been\s+(reprogrammed|updated|reconfigured)/i,
  /pretend\s+(you\s+are|to\s+be|that\s+you)/i,
  /roleplay\s+as/i,
  /assume\s+the\s+(role|identity|persona)\s+of/i,
];

// ── Signal 2: LLM Delimiter Tokens ─────────────────────────────────────────
const DELIMITER_PATTERNS: RegExp[] = [
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<<SYS>>/i,
  /<<\/SYS>>/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /<\|system\|>/i,
  /<\|user\|>/i,
  /<\|assistant\|>/i,
  /\n\nHuman:/,
  /\n\nAssistant:/,
  /###\s*(System|User|Assistant)\s*:/i,
  /---\s*BEGIN\s+SYSTEM\s+PROMPT\s*---/i,
  /---\s*END\s+SYSTEM\s+PROMPT\s*---/i,
  /SYSTEM\s+OVERRIDE/i,
  /<\|endoftext\|>/i,
  /<\|pad\|>/i,
  /\[SYSTEM\]/i,
  /<system>/i,
  /<\/system>/i,
];

// ── Signal 4: Data Exfiltration Patterns ────────────────────────────────────
const EXFILTRATION_PATTERNS: RegExp[] = [
  /forward\s+(all|every|each)\s+(email|message|conversation|data)/i,
  /send\s+(all|every|each|the)\s+(data|information|emails|messages|conversations?)\s+to/i,
  /include\s+(the|your|all)\s+(conversation|thread|history|context|system\s+prompt)/i,
  /reply\s+with\s+(your|the)\s+(system\s+prompt|instructions|configuration|rules)/i,
  /what\s+are\s+your\s+(instructions|rules|guidelines|system\s+prompt)/i,
  /output\s+(your|the)\s+(system|initial)\s+(prompt|instructions)/i,
  /repeat\s+(your|the)\s+(system|initial|original)\s+(prompt|instructions)/i,
  /email\s+me\s+(your|the|all)\s+(data|conversations?|context|system)/i,
  /print\s+(your|the)\s+(system\s+prompt|instructions|configuration)/i,
  /show\s+me\s+(your|the)\s+(system\s+prompt|instructions|rules|internal)/i,
  /reveal\s+(your|the)\s+(system\s+prompt|instructions|configuration)/i,
  /dump\s+(your|the|all)\s+(data|context|memory|conversation|prompt)/i,
  /copy\s+(all|every)\s+(email|message|data|conversation)\s+to/i,
  /exfiltrate/i,
];

// ── Signal 5: Encoding/Obfuscation helpers ──────────────────────────────────
const rot13 = (s: string): string =>
  s.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });

const LEETSPEAK_MAP: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a',
};

const decodeLeetspeak = (s: string): string =>
  s.replace(/[01345@7]/g, (c) => LEETSPEAK_MAP[c] || c);

class PromptInjectionDetector {
  private static instance: PromptInjectionDetector;

  private readonly WEIGHTS = {
    role_override: 0.35,
    delimiter_injection: 0.25,
    hidden_text: 0.20,
    data_exfiltration: 0.15,
    encoding_obfuscation: 0.05,
  };

  private readonly CRITICAL_THRESHOLD = 0.8;
  private readonly HIGH_THRESHOLD = 0.6;
  private readonly MEDIUM_THRESHOLD = 0.4;
  private readonly LOW_THRESHOLD = 0.2;

  private constructor() {}

  public static getInstance(): PromptInjectionDetector {
    if (!PromptInjectionDetector.instance) {
      PromptInjectionDetector.instance = new PromptInjectionDetector();
    }
    return PromptInjectionDetector.instance;
  }

  async analyze(content: string, html?: string, subject?: string): Promise<InjectionAnalysis> {
    const fullText = `${subject || ''} ${content || ''}`.slice(0, MAX_ANALYSIS_LENGTH).toLowerCase();

    const [roleOverride, delimiterInjection, hiddenText, dataExfiltration, encodingObfuscation] =
      await Promise.all([
        this.detectRoleOverride(fullText),
        this.detectDelimiterInjection(fullText),
        this.detectHiddenText(content || '', html),
        this.detectDataExfiltration(fullText),
        this.detectEncodingObfuscation(fullText),
      ]);

    const score =
      roleOverride.score * this.WEIGHTS.role_override +
      delimiterInjection.score * this.WEIGHTS.delimiter_injection +
      hiddenText.score * this.WEIGHTS.hidden_text +
      dataExfiltration.score * this.WEIGHTS.data_exfiltration +
      encodingObfuscation.score * this.WEIGHTS.encoding_obfuscation;

    let risk_level: InjectionAnalysis['risk_level'] = 'none';
    if (score >= this.CRITICAL_THRESHOLD) risk_level = 'critical';
    else if (score >= this.HIGH_THRESHOLD) risk_level = 'high';
    else if (score >= this.MEDIUM_THRESHOLD) risk_level = 'medium';
    else if (score >= this.LOW_THRESHOLD) risk_level = 'low';

    return {
      detected: score >= this.MEDIUM_THRESHOLD,
      confidence: Math.round(Math.min(score, 1.0) * 1000) / 1000,
      risk_level,
      signals: {
        role_override: roleOverride,
        delimiter_injection: delimiterInjection,
        hidden_text: hiddenText,
        data_exfiltration: dataExfiltration,
        encoding_obfuscation: encodingObfuscation,
      },
      summary: this.buildSummary(risk_level, {
        roleOverride,
        delimiterInjection,
        hiddenText,
        dataExfiltration,
        encodingObfuscation,
      }),
    };
  }

  // ── Signal Detectors ──────────────────────────────────────────────────────

  private async detectRoleOverride(text: string): Promise<InjectionSignal> {
    const matches: string[] = [];
    for (const pattern of ROLE_OVERRIDE_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        matches.push(match[0].trim().slice(0, 80));
      }
    }
    return {
      score: Math.min(matches.length * 0.3, 1.0),
      matches,
    };
  }

  private async detectDelimiterInjection(text: string): Promise<InjectionSignal> {
    const matches: string[] = [];
    for (const pattern of DELIMITER_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        matches.push(match[0].trim().slice(0, 40));
      }
    }
    // Any single delimiter is highly suspicious — they never appear in normal email
    if (matches.length === 1) return { score: 0.8, matches };
    if (matches.length > 1) return { score: 1.0, matches };
    return { score: 0, matches };
  }

  private async detectHiddenText(content: string, html?: string): Promise<InjectionSignal> {
    if (!html) return { score: 0, matches: [] };

    const truncatedHtml = html.slice(0, MAX_ANALYSIS_LENGTH);
    const hiddenTexts = this.extractHiddenText(truncatedHtml);

    if (hiddenTexts.length === 0) return { score: 0, matches: [] };

    // Run role override patterns on hidden text specifically
    const combinedHidden = hiddenTexts.join(' ').toLowerCase();
    const injectionInHidden: string[] = [];

    for (const pattern of ROLE_OVERRIDE_PATTERNS) {
      const match = combinedHidden.match(pattern);
      if (match) {
        injectionInHidden.push(match[0].trim().slice(0, 80));
      }
    }
    for (const pattern of EXFILTRATION_PATTERNS) {
      const match = combinedHidden.match(pattern);
      if (match) {
        injectionInHidden.push(match[0].trim().slice(0, 80));
      }
    }

    if (injectionInHidden.length > 0) {
      // Instructions found hidden from human readers = very high confidence
      return {
        score: 1.0,
        matches: injectionInHidden.slice(0, 5),
        technique: 'hidden_instruction',
      };
    }

    // Hidden text exists but doesn't contain injection patterns
    // Still mildly suspicious if there's a lot of it
    if (hiddenTexts.join('').length > 200) {
      return {
        score: 0.3,
        matches: ['significant_hidden_content'],
        technique: 'hidden_content',
      };
    }

    return { score: 0, matches: [] };
  }

  private async detectDataExfiltration(text: string): Promise<InjectionSignal> {
    const matches: string[] = [];
    for (const pattern of EXFILTRATION_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        matches.push(match[0].trim().slice(0, 80));
      }
    }
    return {
      score: Math.min(matches.length * 0.4, 1.0),
      matches,
    };
  }

  private async detectEncodingObfuscation(text: string): Promise<InjectionSignal> {
    const matches: string[] = [];

    // Check for ROT13-encoded injection patterns
    const rot13Decoded = rot13(text);
    for (const pattern of ROLE_OVERRIDE_PATTERNS.slice(0, 5)) {
      if (pattern.test(rot13Decoded) && !pattern.test(text)) {
        matches.push('rot13_encoded_instruction');
        break;
      }
    }

    // Check for leetspeak-encoded patterns
    const leetspeakDecoded = decodeLeetspeak(text);
    for (const pattern of ROLE_OVERRIDE_PATTERNS.slice(0, 5)) {
      if (pattern.test(leetspeakDecoded) && !pattern.test(text)) {
        matches.push('leetspeak_encoded_instruction');
        break;
      }
    }

    // Check for base64 blocks with decode instructions
    if (/base64/i.test(text) && /decode|interpret|execute|run/i.test(text)) {
      const b64Blocks = text.match(/[A-Za-z0-9+/=]{40,}/g);
      if (b64Blocks && b64Blocks.length > 0) {
        try {
          const decoded = Buffer.from(b64Blocks[0], 'base64').toString('utf8');
          // Check if decoded content contains injection patterns
          const lowerDecoded = decoded.toLowerCase();
          for (const pattern of ROLE_OVERRIDE_PATTERNS.slice(0, 5)) {
            if (pattern.test(lowerDecoded)) {
              matches.push('base64_encoded_instruction');
              break;
            }
          }
        } catch {
          // Invalid base64 — ignore
        }
      }
    }

    // Check for excessive Unicode mixing (Cyrillic/Greek lookalikes)
    const cyrillicCount = (text.match(/[\u0400-\u04FF]/g) || []).length;
    const latinCount = (text.match(/[a-zA-Z]/g) || []).length;
    if (cyrillicCount > 5 && latinCount > 5 && cyrillicCount / (cyrillicCount + latinCount) > 0.1) {
      matches.push('mixed_script_obfuscation');
    }

    // Cap at 0.5 to avoid false positives with legitimate encoded content
    return {
      score: Math.min(matches.length * 0.25, 0.5),
      matches,
    };
  }

  // ── HTML Hidden Text Extraction ───────────────────────────────────────────

  private extractHiddenText(html: string): string[] {
    const hiddenTexts: string[] = [];

    // 1. HTML comments (skip short/empty ones)
    const commentRegex = /<!--([\s\S]*?)-->/g;
    let match;
    while ((match = commentRegex.exec(html)) !== null) {
      const commentText = match[1].trim();
      if (commentText.length > 10) {
        hiddenTexts.push(commentText);
      }
    }

    // 2. CSS-hidden elements
    const hidingPatterns = [
      /style\s*=\s*"[^"]*display\s*:\s*none[^"]*"[^>]*>([\s\S]*?)<\//gi,
      /style\s*=\s*"[^"]*visibility\s*:\s*hidden[^"]*"[^>]*>([\s\S]*?)<\//gi,
      /style\s*=\s*"[^"]*opacity\s*:\s*0[^"]*"[^>]*>([\s\S]*?)<\//gi,
      /style\s*=\s*"[^"]*font-size\s*:\s*[01]px[^"]*"[^>]*>([\s\S]*?)<\//gi,
      /style\s*=\s*"[^"]*color\s*:\s*(white|#fff|#ffffff|transparent|rgba\([\d,\s]*0\))[^"]*"[^>]*>([\s\S]*?)<\//gi,
      /style\s*=\s*"[^"]*position\s*:\s*absolute[^"]*left\s*:\s*-\d+[^"]*"[^>]*>([\s\S]*?)<\//gi,
    ];

    for (const pattern of hidingPatterns) {
      pattern.lastIndex = 0; // Reset regex state
      while ((match = pattern.exec(html)) !== null) {
        // Get the last capture group (the content)
        const text = match[match.length - 1]?.replace(/<[^>]+>/g, '').trim();
        if (text && text.length > 10) {
          hiddenTexts.push(text);
        }
      }
    }

    // 3. Zero-width characters used to obfuscate text
    const zwChars = /[\u200B\u200C\u200D\uFEFF\u2060]/g;
    if (zwChars.test(html)) {
      const stripped = html.replace(/<[^>]+>/g, '');
      const withZw = stripped.length;
      const withoutZw = stripped.replace(/[\u200B\u200C\u200D\uFEFF\u2060]/g, '').length;
      // If zero-width chars make up >5% of text, flag it
      if (withZw > 0 && (withZw - withoutZw) / withZw > 0.05) {
        hiddenTexts.push('[zero-width character obfuscation detected]');
      }
    }

    return hiddenTexts;
  }

  // ── Summary Builder ───────────────────────────────────────────────────────

  private buildSummary(
    riskLevel: string,
    signals: {
      roleOverride: InjectionSignal;
      delimiterInjection: InjectionSignal;
      hiddenText: InjectionSignal;
      dataExfiltration: InjectionSignal;
      encodingObfuscation: InjectionSignal;
    }
  ): string {
    if (riskLevel === 'none') return 'No prompt injection signals detected';

    const parts: string[] = [];

    if (signals.roleOverride.score > 0) {
      parts.push(`role override attempt (${signals.roleOverride.matches.length} patterns)`);
    }
    if (signals.delimiterInjection.score > 0) {
      parts.push(`LLM delimiter tokens (${signals.delimiterInjection.matches.length} found)`);
    }
    if (signals.hiddenText.score > 0) {
      const technique = signals.hiddenText.technique || 'hidden content';
      parts.push(`hidden text: ${technique}`);
    }
    if (signals.dataExfiltration.score > 0) {
      parts.push(`data exfiltration attempt (${signals.dataExfiltration.matches.length} patterns)`);
    }
    if (signals.encodingObfuscation.score > 0) {
      parts.push(`encoding obfuscation (${signals.encodingObfuscation.matches.join(', ')})`);
    }

    const prefix = riskLevel === 'critical' || riskLevel === 'high'
      ? 'Likely prompt injection'
      : 'Possible prompt injection signals';

    return `${prefix}: ${parts.join('; ')}`;
  }
}

export { PromptInjectionDetector };
