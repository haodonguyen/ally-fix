import { createLlmClient } from "@ally-fix/llm";
import { resolveLlmClientOptions, resolveLlmConfig } from "../src/env";
import { compareArms, formatComparison, runEval, summariseArm, type CaseResult } from "./run";
import { createAxeVerifier } from "./verify";

/**
 * Runs the golden set twice — once with the WCAG reference block in the prompt,
 * once without — and reports the difference.
 *
 * This is the measurement that decides whether grounding earns its tokens. Both
 * arms share everything else: same cases, same model, same oracle, same
 * anti-deletion instruction. The only difference is the reference block, so the
 * delta is attributable to it.
 *
 *   pnpm --filter @ally-fix/worker eval:compare
 *   EVAL_REPEATS=3 pnpm --filter @ally-fix/worker eval:compare
 */
const repeats = Math.max(1, Number(process.env.EVAL_REPEATS ?? 1) || 1);
const config = resolveLlmConfig();
const baseOptions = resolveLlmClientOptions(config);

const verifier = await createAxeVerifier();

async function arm(grounded: boolean): Promise<CaseResult[][]> {
  const client = createLlmClient(config, { ...baseOptions, grounded });
  const runs: CaseResult[][] = [];
  for (let i = 0; i < repeats; i++) {
    runs.push(await runEval({ client, verifier }));
  }
  return runs;
}

console.log(
  `\nAllyFix grounding comparison — ${config.provider} / ${config.model}, ${repeats} repeat(s) per arm\n`,
);
try {
  // The ungrounded arm runs first so a provider that dies mid-comparison leaves
  // the baseline, not a candidate with nothing to compare against.
  const baseline = summariseArm("ungrounded", await arm(false));
  const candidate = summariseArm("grounded", await arm(true));
  const comparison = compareArms(baseline, candidate);

  console.log(formatComparison(comparison));
  console.log("");

  const broken = baseline.counts["broken-case"] + candidate.counts["broken-case"];
  // As in `index.ts`: the score is the output, but a broken dataset means the
  // comparison proved nothing.
  process.exitCode = broken > 0 ? 1 : 0;
} finally {
  await verifier.close();
}
