import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPromptInjectionBenchmark } from '../securityEval/promptBenchmarkRunner';

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;

const main = async () => {
  const includeMutations = process.env.PROMPT_EVAL_INCLUDE_MUTATIONS !== 'false';
  const includeBenignMutations = process.env.PROMPT_EVAL_INCLUDE_BENIGN_MUTATIONS !== 'false';

  const { results, summary } = await runPromptInjectionBenchmark({
    includeMutations,
    includeBenignMutations,
  });

  console.log('\nPrompt Injection Benchmark Summary');
  console.log('--------------------------------');
  console.log(`Total: ${summary.total}`);
  console.log(`Passes: ${summary.passes}`);
  console.log(`Failures: ${summary.failures}`);
  console.log(`Precision: ${pct(summary.precision)}`);
  console.log(`Recall: ${pct(summary.recall)}`);
  console.log(`F1: ${pct(summary.f1)}`);
  console.log(`False Positives: ${summary.false_positive}`);
  console.log(`False Negatives: ${summary.false_negative}`);

  console.log('\nBy Funnel');
  for (const [funnel, stats] of Object.entries(summary.by_funnel)) {
    console.log(
      `${funnel.toUpperCase()}: total=${stats.total} pass_rate=${pct(stats.pass_rate)} fp=${stats.fp} fn=${stats.fn}`
    );
  }

  console.log('\nBy Sophistication');
  for (const [level, stats] of Object.entries(summary.by_sophistication)) {
    console.log(
      `${level}: total=${stats.total} pass_rate=${pct(stats.pass_rate)} fp=${stats.fp} fn=${stats.fn}`
    );
  }

  const failures = results.filter((item) => !item.pass).slice(0, 20);
  if (failures.length > 0) {
    console.log('\nTop Failures');
    for (const failure of failures) {
      console.log(
        `- ${failure.id} [${failure.funnel}/${failure.sophistication}] label=${failure.label} expected=${failure.expected_min_risk || 'none'}..${failure.expected_max_risk || 'critical'} got=${failure.predicted_risk} detected=${failure.detected}`
      );
    }
  }

  const outputPath = process.env.PROMPT_EVAL_OUTPUT_PATH || resolve(process.cwd(), 'logs/prompt-injection-benchmark.json');
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        include_mutations: includeMutations,
        include_benign_mutations: includeBenignMutations,
        summary,
        results,
      },
      null,
      2
    )
  );
  console.log(`\nWrote benchmark report: ${outputPath}`);

  if (summary.failures > 0 && process.env.PROMPT_EVAL_STRICT === 'true') {
    process.exit(1);
  }
};

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
