import type { InjectionAnalysis } from '../services/security/promptDetectionTypes';
import { PromptInjectionDetector } from '../services/security/promptInjectionDetector';
import type {
  EvaluationCaseResult,
  EvaluationSummary,
  PromptInjectionFixture,
  RiskLevel,
  FunnelStage,
  Sophistication,
} from './promptEvalTypes';
import { PROMPT_INJECTION_FIXTURES } from './promptFixtureLibrary';
import { generateMutatedFixtures } from './promptMutationEngine';

const riskValue: Record<RiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const toRiskValue = (value?: RiskLevel): number => (value ? riskValue[value] : -1);

const evaluatePass = (fixture: PromptInjectionFixture, analysis: InjectionAnalysis): boolean => {
  const actual = toRiskValue(analysis.risk_level);
  const min = toRiskValue(fixture.expected_min_risk);
  const max = toRiskValue(fixture.expected_max_risk);

  if (min >= 0 && actual < min) return false;
  if (max >= 0 && actual > max) return false;
  if (fixture.label === 'malicious' && !analysis.detected) return false;
  if (fixture.label === 'benign' && analysis.risk_level === 'critical') return false;
  return true;
};

const computeSummary = (results: EvaluationCaseResult[]): EvaluationSummary => {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  let passes = 0;

  const byFunnel: EvaluationSummary['by_funnel'] = {
    tofu: { total: 0, fp: 0, fn: 0, pass_rate: 0 },
    mofu: { total: 0, fp: 0, fn: 0, pass_rate: 0 },
    bofu: { total: 0, fp: 0, fn: 0, pass_rate: 0 },
  };

  const bySophistication: EvaluationSummary['by_sophistication'] = {
    low: { total: 0, fp: 0, fn: 0, pass_rate: 0 },
    medium: { total: 0, fp: 0, fn: 0, pass_rate: 0 },
    high: { total: 0, fp: 0, fn: 0, pass_rate: 0 },
    edge: { total: 0, fp: 0, fn: 0, pass_rate: 0 },
  };

  const passCountByFunnel: Record<FunnelStage, number> = { tofu: 0, mofu: 0, bofu: 0 };
  const passCountBySoph: Record<Sophistication, number> = { low: 0, medium: 0, high: 0, edge: 0 };

  for (const result of results) {
    const predictedPositive = result.detected;
    const actualPositive = result.label === 'malicious';
    if (result.pass) passes += 1;

    byFunnel[result.funnel].total += 1;
    bySophistication[result.sophistication].total += 1;
    if (result.pass) {
      passCountByFunnel[result.funnel] += 1;
      passCountBySoph[result.sophistication] += 1;
    }

    if (predictedPositive && actualPositive) tp += 1;
    else if (!predictedPositive && !actualPositive) tn += 1;
    else if (predictedPositive && !actualPositive) {
      fp += 1;
      byFunnel[result.funnel].fp += 1;
      bySophistication[result.sophistication].fp += 1;
    } else {
      fn += 1;
      byFunnel[result.funnel].fn += 1;
      bySophistication[result.sophistication].fn += 1;
    }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  for (const key of Object.keys(byFunnel) as FunnelStage[]) {
    const total = byFunnel[key].total || 1;
    byFunnel[key].pass_rate = passCountByFunnel[key] / total;
  }
  for (const key of Object.keys(bySophistication) as Sophistication[]) {
    const total = bySophistication[key].total || 1;
    bySophistication[key].pass_rate = passCountBySoph[key] / total;
  }

  return {
    total: results.length,
    passes,
    failures: results.length - passes,
    true_positive: tp,
    true_negative: tn,
    false_positive: fp,
    false_negative: fn,
    precision,
    recall,
    f1,
    by_funnel: byFunnel,
    by_sophistication: bySophistication,
  };
};

export const runPromptInjectionBenchmark = async (options?: {
  includeMutations?: boolean;
  includeBenignMutations?: boolean;
}): Promise<{
  results: EvaluationCaseResult[];
  summary: EvaluationSummary;
}> => {
  const includeMutations = options?.includeMutations !== false;
  const includeBenignMutations = options?.includeBenignMutations !== false;

  const fixtures: PromptInjectionFixture[] = [...PROMPT_INJECTION_FIXTURES];
  if (includeMutations) {
    fixtures.push(...generateMutatedFixtures(PROMPT_INJECTION_FIXTURES, { includeBenignMutations }));
  }

  const detector = PromptInjectionDetector.getInstance();
  const results: EvaluationCaseResult[] = [];

  for (const fixture of fixtures) {
    const analysis = await detector.analyze(fixture.content, fixture.html, fixture.subject);
    const pass = evaluatePass(fixture, analysis);
    results.push({
      id: fixture.id,
      title: fixture.title,
      funnel: fixture.funnel,
      sophistication: fixture.sophistication,
      label: fixture.label,
      categories: fixture.categories,
      mutation_strategy: 'mutation_strategy' in fixture ? (fixture as any).mutation_strategy : undefined,
      expected_min_risk: fixture.expected_min_risk,
      expected_max_risk: fixture.expected_max_risk,
      predicted_risk: analysis.risk_level,
      detected: analysis.detected,
      confidence: analysis.confidence,
      fusion_score: analysis.fusion_score,
      model_checked: analysis.model_checked,
      reason_codes: analysis.reason_codes || [],
      pass,
    });
  }

  return {
    results,
    summary: computeSummary(results),
  };
};

