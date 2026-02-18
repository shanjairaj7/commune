/**
 * Prompt Injection Detection for AI Agents (v2)
 *
 * Detection-only pipeline:
 *   canonicalize -> heuristic scoring -> structured LLM adjudication -> fusion.
 *
 * Never blocks delivery. Returns metadata for downstream agent decisions.
 */

import logger from '../../utils/logger';
import { canonicalizePromptInputs } from './promptCanonicalizer';
import { PromptSafetyAdjudicatorService } from './promptSafetyAdjudicatorService';
import { fusePromptRisk } from './promptRiskFusion';
import type {
  HeuristicAnalysisResult,
  InjectionAnalysis,
  InjectionSignal,
  PromptInjectionSignals,
} from './promptDetectionTypes';

const DETECTOR_ENABLED = process.env.PROMPT_INJECTION_DETECTOR_ENABLED !== 'false';
const SHADOW_MODE = process.env.PROMPT_INJECTION_SHADOW_MODE === 'true';
const FUSION_VERSION = process.env.PROMPT_INJECTION_FUSION_VERSION || 'v1';
const DETECTION_POLICY_VERSION = process.env.PROMPT_INJECTION_POLICY_VERSION || 'v2';
const MAX_ANALYSIS_LENGTH = 50_000;

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

const SECURITY_CONTEXT_SUPPRESSORS: RegExp[] = [
  /\bsecurity\s+training\b/i,
  /\bexample\s+prompt\s+injection\b/i,
  /\bdetect(ing)?\s+prompt\s+injection\b/i,
  /\bjailbreak\s+mitigation\b/i,
  /\bred\s+team(ing)?\b/i,
  /\bthis\s+is\s+an?\s+example\b/i,
  /\bfor\s+educational\s+purposes\b/i,
  /```[\s\S]*?(ignore|system prompt|jailbreak)[\s\S]*?```/i,
];

const rot13 = (s: string): string =>
  s.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });

const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));

class PromptInjectionDetector {
  private static instance: PromptInjectionDetector;
  private readonly adjudicator = PromptSafetyAdjudicatorService.getInstance();

  private constructor() {}

  public static getInstance(): PromptInjectionDetector {
    if (!PromptInjectionDetector.instance) {
      PromptInjectionDetector.instance = new PromptInjectionDetector();
    }
    return PromptInjectionDetector.instance;
  }

  async analyze(
    content: string,
    html?: string,
    subject?: string,
    options?: { enableAdjudicator?: boolean }
  ): Promise<InjectionAnalysis> {
    if (!DETECTOR_ENABLED) {
      return {
        detected: false,
        confidence: 0,
        risk_level: 'none',
        signals: {
          role_override: { score: 0, matches: [] },
          delimiter_injection: { score: 0, matches: [] },
          hidden_text: { score: 0, matches: [] },
          data_exfiltration: { score: 0, matches: [] },
          encoding_obfuscation: { score: 0, matches: [] },
        },
        summary: 'Prompt injection detector disabled',
        reason_codes: ['detector_disabled'],
        heuristic_score: 0,
        model_checked: false,
        fusion_score: 0,
        fusion_version: FUSION_VERSION,
      };
    }

    const canonical = canonicalizePromptInputs({
      subject: (subject || '').slice(0, MAX_ANALYSIS_LENGTH),
      text: (content || '').slice(0, MAX_ANALYSIS_LENGTH),
      html: (html || '').slice(0, MAX_ANALYSIS_LENGTH),
    });

    const heuristic = this.runHeuristicAnalysis(
      canonical.canonical_text,
      canonical.raw_compact_text,
      canonical.hidden_texts
    );
    const shouldUseAdjudicator = options?.enableAdjudicator !== false;
    const adjudicator = shouldUseAdjudicator
      ? await this.adjudicator.adjudicate(canonical, heuristic)
      : {
        checked: false,
        provider: 'azure-openai-compatible',
        model_version: process.env.PROMPT_INJECTION_ADJUDICATOR_DEPLOYMENT || process.env.AZURE_OPENAI_DEPLOYMENT || 'grok-3-mini',
        score: 0,
        confidence: 0,
        risk_level: 'none' as const,
        is_prompt_injection: false,
        attack_categories: [],
        exfiltration_intent: false,
        obfuscation_detected: false,
        reason_codes: [],
        error_code: 'adjudicator_plan_gated',
      };
    const fusion = fusePromptRisk({
      heuristic,
      adjudicator,
      shadow_mode: SHADOW_MODE,
      fusion_version: FUSION_VERSION,
    });

    if (fusion.detected) {
      logger.warn('Prompt injection detected', {
        risk_level: fusion.risk_level,
        heuristic_score: heuristic.score,
        model_checked: fusion.model_checked,
        model_score: fusion.model_score,
        fusion_score: fusion.score,
        disagreement: fusion.disagreement,
        policy_version: DETECTION_POLICY_VERSION,
      });
    }

    return {
      detected: fusion.detected,
      confidence: fusion.score,
      risk_level: fusion.risk_level,
      signals: heuristic.signals,
      summary: this.buildSummary(fusion.risk_level, heuristic.signals, fusion.reason_codes),
      reason_codes: fusion.reason_codes,
      heuristic_score: heuristic.score,
      model_checked: fusion.model_checked,
      model_provider: fusion.model_provider,
      model_version: fusion.model_version,
      model_score: fusion.model_score,
      model_error: fusion.model_error,
      fusion_score: fusion.score,
      fusion_version: FUSION_VERSION,
      disagreement: fusion.disagreement,
    };
  }

  private runHeuristicAnalysis(
    text: string,
    rawText: string,
    hiddenTexts: string[]
  ): HeuristicAnalysisResult {
    const roleOverride = this.detectPatternList(text, ROLE_OVERRIDE_PATTERNS, 0.3, 80);
    const delimiterInjection = this.detectDelimiterInjection(text);
    const hiddenText = this.detectHiddenText(hiddenTexts);
    const dataExfiltration = this.detectPatternList(text, EXFILTRATION_PATTERNS, 0.4, 80);
    const encodingObfuscation = this.detectEncodingObfuscation(rawText);
    const suppressor = this.detectSuppressor(text);

    const rawScore = (
      roleOverride.score * 0.35 +
      delimiterInjection.score * 0.25 +
      hiddenText.score * 0.2 +
      dataExfiltration.score * 0.15 +
      encodingObfuscation.score * 0.05
    );

    const suppressionFactor = 1 - (suppressor.score * 0.5);
    const score = clamp(rawScore * suppressionFactor);

    const reasonCodes: string[] = [];
    if (roleOverride.score > 0) reasonCodes.push('role_override_detected');
    if (delimiterInjection.score > 0) reasonCodes.push('delimiter_injection_detected');
    if (hiddenText.score > 0) reasonCodes.push(`hidden_text_${hiddenText.technique || 'detected'}`);
    if (dataExfiltration.score > 0) reasonCodes.push('data_exfiltration_detected');
    if (encodingObfuscation.score > 0) reasonCodes.push('encoding_obfuscation_detected');
    if (suppressor.score > 0) reasonCodes.push('contextual_suppressor_detected');

    const signals: PromptInjectionSignals = {
      role_override: roleOverride,
      delimiter_injection: delimiterInjection,
      hidden_text: hiddenText,
      data_exfiltration: dataExfiltration,
      encoding_obfuscation: encodingObfuscation,
    };

    return {
      score: Math.round(score * 1000) / 1000,
      suppressor_score: suppressor.score,
      signals,
      reason_codes: reasonCodes,
      has_high_confidence_hidden_instruction: hiddenText.technique === 'hidden_instruction',
      has_exfiltration_intent: dataExfiltration.score >= 0.4,
      has_obfuscation_intent: encodingObfuscation.score >= 0.25,
    };
  }

  private detectPatternList(
    text: string,
    patterns: RegExp[],
    multiplier: number,
    maxSnippetLength: number
  ): InjectionSignal {
    const matches: string[] = [];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) matches.push(match[0].trim().slice(0, maxSnippetLength));
    }
    return {
      score: clamp(matches.length * multiplier),
      matches,
    };
  }

  private detectDelimiterInjection(text: string): InjectionSignal {
    const matches: string[] = [];
    for (const pattern of DELIMITER_PATTERNS) {
      const match = text.match(pattern);
      if (match) matches.push(match[0].trim().slice(0, 40));
    }
    if (matches.length === 1) return { score: 0.8, matches };
    if (matches.length > 1) return { score: 1.0, matches };
    return { score: 0, matches };
  }

  private detectHiddenText(hiddenTexts: string[]): InjectionSignal {
    if (hiddenTexts.length === 0) return { score: 0, matches: [] };
    const combinedHidden = hiddenTexts.join(' ').toLowerCase();
    const hiddenInstructionMatches: string[] = [];

    for (const pattern of ROLE_OVERRIDE_PATTERNS) {
      const match = combinedHidden.match(pattern);
      if (match) hiddenInstructionMatches.push(match[0].trim().slice(0, 80));
    }
    for (const pattern of EXFILTRATION_PATTERNS) {
      const match = combinedHidden.match(pattern);
      if (match) hiddenInstructionMatches.push(match[0].trim().slice(0, 80));
    }

    if (hiddenInstructionMatches.length > 0) {
      return {
        score: 1.0,
        matches: hiddenInstructionMatches.slice(0, 5),
        technique: 'hidden_instruction',
      };
    }

    if (hiddenTexts.join('').length > 200) {
      return {
        score: 0.3,
        matches: ['significant_hidden_content'],
        technique: 'hidden_content',
      };
    }
    return { score: 0, matches: [] };
  }

  private detectEncodingObfuscation(text: string): InjectionSignal {
    const matches: string[] = [];

    const rot13Decoded = rot13(text);
    for (const pattern of ROLE_OVERRIDE_PATTERNS.slice(0, 5)) {
      if (pattern.test(rot13Decoded) && !pattern.test(text)) {
        matches.push('rot13_encoded_instruction');
        break;
      }
    }

    if (/base64/i.test(text) && /decode|interpret|execute|run/i.test(text)) {
      const b64Blocks = text.match(/[A-Za-z0-9+/=]{40,}/g);
      if (b64Blocks && b64Blocks.length > 0) {
        try {
          const decoded = Buffer.from(b64Blocks[0], 'base64').toString('utf8').toLowerCase();
          for (const pattern of ROLE_OVERRIDE_PATTERNS.slice(0, 5)) {
            if (pattern.test(decoded)) {
              matches.push('base64_encoded_instruction');
              break;
            }
          }
        } catch {
          // Ignore parse failures.
        }
      }
    }

    const cyrillicCount = (text.match(/[\u0400-\u04FF]/g) || []).length;
    const latinCount = (text.match(/[a-zA-Z]/g) || []).length;
    if (cyrillicCount > 5 && latinCount > 5 && cyrillicCount / (cyrillicCount + latinCount) > 0.1) {
      matches.push('mixed_script_obfuscation');
    }

    return {
      score: Math.min(matches.length * 0.25, 0.5),
      matches,
    };
  }

  private detectSuppressor(text: string): InjectionSignal {
    const matches: string[] = [];
    for (const pattern of SECURITY_CONTEXT_SUPPRESSORS) {
      const match = text.match(pattern);
      if (match) matches.push(match[0].trim().slice(0, 80));
    }
    return {
      score: Math.min(matches.length * 0.2, 1),
      matches,
      technique: matches.length ? 'contextual_suppressor' : undefined,
    };
  }

  private buildSummary(
    riskLevel: string,
    signals: PromptInjectionSignals,
    reasonCodes: string[]
  ): string {
    if (riskLevel === 'none') {
      if (reasonCodes.includes('contextual_suppressor_detected')) {
        return 'Suspicious patterns appeared in likely educational/security context';
      }
      return 'No prompt injection signals detected';
    }

    const parts: string[] = [];
    if (signals.role_override.score > 0) {
      parts.push(`role override attempt (${signals.role_override.matches.length} patterns)`);
    }
    if (signals.delimiter_injection.score > 0) {
      parts.push(`LLM delimiter tokens (${signals.delimiter_injection.matches.length} found)`);
    }
    if (signals.hidden_text.score > 0) {
      parts.push(`hidden text: ${signals.hidden_text.technique || 'hidden_content'}`);
    }
    if (signals.data_exfiltration.score > 0) {
      parts.push(`data exfiltration attempt (${signals.data_exfiltration.matches.length} patterns)`);
    }
    if (signals.encoding_obfuscation.score > 0) {
      parts.push(`encoding obfuscation (${signals.encoding_obfuscation.matches.join(', ')})`);
    }
    if (reasonCodes.includes('contextual_suppressor_detected')) {
      parts.push('context suggests educational or defensive discussion');
    }

    const prefix = riskLevel === 'critical' || riskLevel === 'high'
      ? 'Likely prompt injection'
      : 'Possible prompt injection signals';

    return `${prefix}: ${parts.join('; ')}`;
  }
}

export { PromptInjectionDetector };
