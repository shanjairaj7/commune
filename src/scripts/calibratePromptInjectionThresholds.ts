import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPromptInjectionBenchmark } from '../securityEval/promptBenchmarkRunner';
import type { EvaluationCaseResult, RiskLevel } from '../securityEval/promptEvalTypes';

const riskValue: Record<RiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const scoreToRisk = (
  score: number,
  thresholds: { low: number; medium: number; high: number; critical: number }
): RiskLevel => {
  if (score >= thresholds.critical) return 'critical';
  if (score >= thresholds.high) return 'high';
  if (score >= thresholds.medium) return 'medium';
  if (score >= thresholds.low) return 'low';
  return 'none';
};

const evaluateConfig = (
  rows: Array<EvaluationCaseResult & { evalScore: number }>,
  thresholds: { low: number; medium: number; high: number; critical: number; detect: number }
) => {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let pass = 0;

  for (const row of rows) {
    const predictedRisk = scoreToRisk(row.evalScore, thresholds);
    const detected = row.evalScore >= thresholds.detect;
    const malicious = row.label === 'malicious';

    if (detected && malicious) tp += 1;
    else if (detected && !malicious) fp += 1;
    else if (!detected && malicious) fn += 1;
    else tn += 1;

    const actualVal = riskValue[predictedRisk];
    const minVal = row.expected_min_risk ? riskValue[row.expected_min_risk] : -1;
    const maxVal = row.expected_max_risk ? riskValue[row.expected_max_risk] : 4;
    const withinRange = actualVal >= minVal && actualVal <= maxVal;
    const passCase = withinRange && !(malicious && !detected) && !(!malicious && predictedRisk === 'critical');
    if (passCase) pass += 1;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;
  const passRate = pass / rows.length;
  return { tp, fp, fn, tn, precision, recall, f1, fpr, passRate };
};

const range = (start: number, end: number, step: number): number[] => {
  const values: number[] = [];
  for (let v = start; v <= end + 1e-9; v += step) values.push(Number(v.toFixed(3)));
  return values;
};

const main = async () => {
  const maxFpr = Number(process.env.PROMPT_EVAL_MAX_FPR || 0.15);
  const includeMutations = process.env.PROMPT_EVAL_INCLUDE_MUTATIONS !== 'false';
  const includeBenignMutations = process.env.PROMPT_EVAL_INCLUDE_BENIGN_MUTATIONS !== 'false';

  const { results } = await runPromptInjectionBenchmark({ includeMutations, includeBenignMutations });
  const rows = results.map((result) => ({
    ...result,
    evalScore: typeof result.fusion_score === 'number' ? result.fusion_score : result.confidence,
  }));

  const detectValues = range(0.28, 0.6, 0.02);
  const highValues = range(0.52, 0.82, 0.02);
  const criticalValues = range(0.74, 0.94, 0.02);

  let best: any = null;
  for (const detect of detectValues) {
    const medium = detect;
    for (const high of highValues) {
      if (high <= medium + 0.04) continue;
      for (const critical of criticalValues) {
        if (critical <= high + 0.04) continue;
        const thresholds = { low: 0.2, medium, high, critical, detect };
        const metrics = evaluateConfig(rows, thresholds);
        if (metrics.fpr > maxFpr) continue;

        const objective = (metrics.f1 * 0.55) + (metrics.passRate * 0.45) - (metrics.fpr * 0.2);
        if (!best || objective > best.objective) {
          best = { thresholds, metrics, objective };
        }
      }
    }
  }

  if (!best) {
    console.error('No threshold configuration satisfied FPR constraint.');
    process.exit(1);
  }

  console.log('\nBest threshold calibration');
  console.log(JSON.stringify(best, null, 2));

  const envRecommendations = {
    PROMPT_INJECTION_DETECT_THRESHOLD: best.thresholds.detect,
    PROMPT_INJECTION_RISK_LOW_THRESHOLD: best.thresholds.low,
    PROMPT_INJECTION_RISK_MEDIUM_THRESHOLD: best.thresholds.medium,
    PROMPT_INJECTION_RISK_HIGH_THRESHOLD: best.thresholds.high,
    PROMPT_INJECTION_RISK_CRITICAL_THRESHOLD: best.thresholds.critical,
  };

  console.log('\nRecommended env vars');
  Object.entries(envRecommendations).forEach(([key, value]) => {
    console.log(`${key}=${value}`);
  });

  const outputPath = process.env.PROMPT_EVAL_CALIBRATION_OUTPUT_PATH ||
    resolve(process.cwd(), 'logs/prompt-injection-calibration.json');

  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        constraints: { max_fpr: maxFpr },
        best,
        env_recommendations: envRecommendations,
      },
      null,
      2
    )
  );

  console.log(`\nWrote calibration report: ${outputPath}`);
};

main().catch((error) => {
  console.error('Calibration failed:', error);
  process.exit(1);
});
