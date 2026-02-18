export type FunnelStage = 'tofu' | 'mofu' | 'bofu';
export type Sophistication = 'low' | 'medium' | 'high' | 'edge';
export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type FixtureLabel = 'benign' | 'malicious';

export interface PromptInjectionFixture {
  id: string;
  title: string;
  funnel: FunnelStage;
  sophistication: Sophistication;
  label: FixtureLabel;
  categories: string[];
  subject: string;
  content: string;
  html?: string;
  expected_min_risk?: RiskLevel;
  expected_max_risk?: RiskLevel;
}

export interface MutatedFixture extends PromptInjectionFixture {
  base_id: string;
  mutation_strategy: string;
}

export interface EvaluationCaseResult {
  id: string;
  title: string;
  funnel: FunnelStage;
  sophistication: Sophistication;
  label: FixtureLabel;
  categories: string[];
  mutation_strategy?: string;
  expected_min_risk?: RiskLevel;
  expected_max_risk?: RiskLevel;
  predicted_risk: RiskLevel;
  detected: boolean;
  confidence: number;
  fusion_score?: number;
  model_checked?: boolean;
  reason_codes: string[];
  pass: boolean;
}

export interface EvaluationSummary {
  total: number;
  passes: number;
  failures: number;
  true_positive: number;
  true_negative: number;
  false_positive: number;
  false_negative: number;
  precision: number;
  recall: number;
  f1: number;
  by_funnel: Record<FunnelStage, {
    total: number;
    fp: number;
    fn: number;
    pass_rate: number;
  }>;
  by_sophistication: Record<Sophistication, {
    total: number;
    fp: number;
    fn: number;
    pass_rate: number;
  }>;
}

