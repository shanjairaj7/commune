import type {
  FusionInput,
  FusionResult,
  PromptInjectionRiskLevel,
} from './promptDetectionTypes';

const HEURISTIC_WEIGHT = Number(process.env.PROMPT_INJECTION_WEIGHT_HEURISTIC || 0.55);
const MODEL_WEIGHT = Number(process.env.PROMPT_INJECTION_WEIGHT_MODEL || 0.45);
const LOW_THRESHOLD = Number(process.env.PROMPT_INJECTION_RISK_LOW_THRESHOLD || 0.2);
const MEDIUM_THRESHOLD = Number(process.env.PROMPT_INJECTION_RISK_MEDIUM_THRESHOLD || 0.4);
const HIGH_THRESHOLD = Number(process.env.PROMPT_INJECTION_RISK_HIGH_THRESHOLD || 0.6);
const CRITICAL_THRESHOLD = Number(process.env.PROMPT_INJECTION_RISK_CRITICAL_THRESHOLD || 0.8);
const DETECT_THRESHOLD = Number(process.env.PROMPT_INJECTION_DETECT_THRESHOLD || 0.4);

const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));

const riskLevelFromScore = (score: number): PromptInjectionRiskLevel => {
  if (score >= CRITICAL_THRESHOLD) return 'critical';
  if (score >= HIGH_THRESHOLD) return 'high';
  if (score >= MEDIUM_THRESHOLD) return 'medium';
  if (score >= LOW_THRESHOLD) return 'low';
  return 'none';
};

const minRiskScore = (level: PromptInjectionRiskLevel): number => {
  switch (level) {
    case 'critical': return CRITICAL_THRESHOLD;
    case 'high': return HIGH_THRESHOLD;
    case 'medium': return MEDIUM_THRESHOLD;
    case 'low': return LOW_THRESHOLD;
    default: return 0;
  }
};

export const fusePromptRisk = (input: FusionInput): FusionResult => {
  const heuristicScore = clamp(input.heuristic.score);
  const modelChecked = input.adjudicator.checked;
  const modelScore = modelChecked ? clamp(input.adjudicator.score) : undefined;

  const fusedBaseScore = modelChecked && typeof modelScore === 'number'
    ? clamp((heuristicScore * HEURISTIC_WEIGHT) + (modelScore * MODEL_WEIGHT))
    : heuristicScore;

  let fusionScore = fusedBaseScore;
  const reasonCodes = [
    ...input.heuristic.reason_codes,
    ...input.adjudicator.reason_codes,
  ];

  if (input.heuristic.has_high_confidence_hidden_instruction) {
    fusionScore = Math.max(fusionScore, minRiskScore('high'));
    reasonCodes.push('override_hidden_instruction_floor');
  }

  if (
    input.heuristic.signals.role_override.score >= 0.3 &&
    input.heuristic.signals.delimiter_injection.score >= 0.8
  ) {
    fusionScore = Math.max(fusionScore, minRiskScore('high'));
    reasonCodes.push('override_role_delimiter_floor');
  }

  if (input.heuristic.has_exfiltration_intent && input.heuristic.has_obfuscation_intent) {
    fusionScore = Math.max(fusionScore, minRiskScore('high'));
    reasonCodes.push('override_exfiltration_obfuscation_floor');
  }

  if (reasonCodes.includes('direct_hijack_exfiltration_combo')) {
    fusionScore = Math.max(fusionScore, minRiskScore('high'));
    reasonCodes.push('override_direct_hijack_exfiltration_floor');
  }

  if (reasonCodes.includes('tool_poisoning_exfiltration_combo')) {
    fusionScore = Math.max(fusionScore, minRiskScore('high'));
    reasonCodes.push('override_tool_poisoning_exfiltration_floor');
  }

  if (reasonCodes.includes('authority_laundering_exfiltration_combo')) {
    fusionScore = Math.max(fusionScore, minRiskScore('high'));
    reasonCodes.push('override_authority_laundering_floor');
  }

  if (reasonCodes.includes('sensitive_exfiltration_detected')) {
    fusionScore = Math.max(fusionScore, minRiskScore('medium'));
    reasonCodes.push('override_sensitive_exfiltration_floor');
  }

  if (
    reasonCodes.includes('strong_role_hijack_detected') &&
    !reasonCodes.includes('contextual_suppressor_detected')
  ) {
    fusionScore = Math.max(fusionScore, minRiskScore('medium'));
    reasonCodes.push('override_role_hijack_floor');
  }

  if (reasonCodes.includes('delimiter_command_combo')) {
    fusionScore = Math.max(fusionScore, minRiskScore('high'));
    reasonCodes.push('override_delimiter_command_floor');
  }

  if (reasonCodes.includes('many_shot_exfiltration_combo')) {
    fusionScore = Math.max(fusionScore, minRiskScore('medium'));
    reasonCodes.push('override_many_shot_floor');
  }

  if (reasonCodes.includes('delayed_trigger_detected') && reasonCodes.includes('role_override_detected')) {
    fusionScore = Math.max(fusionScore, minRiskScore('medium'));
    reasonCodes.push('override_delayed_role_floor');
  }

  let disagreement: FusionResult['disagreement'];
  if (modelChecked && typeof modelScore === 'number') {
    if (modelScore >= 0.6 && heuristicScore < 0.4) disagreement = 'model_high_rule_low';
    if (heuristicScore >= 0.6 && modelScore < 0.4) disagreement = 'rule_high_model_low';
  }

  if (input.shadow_mode) {
    fusionScore = heuristicScore;
    reasonCodes.push('shadow_mode_heuristic_decision');
  }

  const riskLevel = riskLevelFromScore(fusionScore);
  return {
    score: Math.round(clamp(fusionScore) * 1000) / 1000,
    risk_level: riskLevel,
    detected: fusionScore >= DETECT_THRESHOLD,
    disagreement,
    reason_codes: Array.from(new Set(reasonCodes)),
    model_checked: modelChecked,
    model_score: modelScore,
    model_provider: input.adjudicator.provider,
    model_version: input.adjudicator.model_version,
    model_error: input.adjudicator.error_code,
  };
};
