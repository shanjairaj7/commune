export type PromptInjectionRiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export interface InjectionSignal {
  score: number;
  matches: string[];
  technique?: string;
}

export interface PromptInjectionSignals {
  role_override: InjectionSignal;
  delimiter_injection: InjectionSignal;
  hidden_text: InjectionSignal;
  data_exfiltration: InjectionSignal;
  encoding_obfuscation: InjectionSignal;
}

export interface HeuristicAnalysisResult {
  score: number;
  suppressor_score: number;
  signals: PromptInjectionSignals;
  reason_codes: string[];
  has_high_confidence_hidden_instruction: boolean;
  has_exfiltration_intent: boolean;
  has_obfuscation_intent: boolean;
}

export interface PromptAdjudicationResult {
  checked: boolean;
  provider: string;
  model_version: string;
  score: number;
  confidence: number;
  risk_level: PromptInjectionRiskLevel;
  is_prompt_injection: boolean;
  attack_categories: string[];
  exfiltration_intent: boolean;
  obfuscation_detected: boolean;
  reason_codes: string[];
  error_code?: string;
  latency_ms?: number;
}

export interface FusionInput {
  heuristic: HeuristicAnalysisResult;
  adjudicator: PromptAdjudicationResult;
  shadow_mode: boolean;
  fusion_version: string;
}

export interface FusionResult {
  score: number;
  risk_level: PromptInjectionRiskLevel;
  detected: boolean;
  disagreement?: 'model_high_rule_low' | 'rule_high_model_low';
  reason_codes: string[];
  model_checked: boolean;
  model_score?: number;
  model_provider?: string;
  model_version?: string;
  model_error?: string;
}

export interface InjectionAnalysis {
  detected: boolean;
  confidence: number;
  risk_level: PromptInjectionRiskLevel;
  signals: PromptInjectionSignals;
  summary: string;
  reason_codes?: string[];
  heuristic_score?: number;
  model_checked?: boolean;
  model_provider?: string;
  model_version?: string;
  model_score?: number;
  model_error?: string;
  fusion_score?: number;
  fusion_version?: string;
  disagreement?: 'model_high_rule_low' | 'rule_high_model_low';
}

