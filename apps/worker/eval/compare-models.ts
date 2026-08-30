import { fileURLToPath } from "node:url";
import { createLlmClient } from "@ally-fix/llm";
import { resolveLlmClientOptions } from "../src/env";
import { loadModelComparison, toArm } from "./models";
import { formatArmTable, runEval, summariseArm, type CaseResult } from "./run";
import { createAxeVerifier } from "./verify";

/**
 * Scores several models against the same golden set and prints them side by side.
 *
 * "Which model should this use?" is otherwise answered by whichever one someone
 * tried first. With the oracle from `eval/` and the token accounting from
 * ADR-0008 already in place, the answer becomes a table: resolved rate, latency,
 * prompt size, and dollars per fix.
 *
 *   cp eval/models.example.json eval/models.json   # then edit it
 *   pnpm --filter @ally-fix/worker eval:models
 */
const configPath =
  process.env.EVAL_MODELS_FILE ?? fileURLToPath(new URL("./models.json", import.meta.url));

const comparison = loadModelComparison(configPath);
// Keys are resolved for every arm before the first call, so a missing one fails
// in a second rather than after a long run has already scored it as useless.
const arms = comparison.models.map((entry) => toArm(entry));
const repeats = Math.max(1, Number(process.env.EVAL_REPEATS ?? comparison.repeats) || 1);

const verifier = await createAxeVerifier();

console.log(
  `\nAllyFix model comparison — ${arms.length} models, ${repeats} repeat(s) each\n` +
    `  config: ${configPath}\n`,
);
try {
  const scored = [];
  for (const arm of arms) {
    // Client options come from the environment as usual, so every arm runs under
    // the same timeout, retry, and rate-limit policy. Only the model differs.
    //
    // Prices are the exception: they come from this comparison's own config and
    // nowhere else. Falling back to the global LLM_PRICE_* would charge a local
    // Ollama arm at whatever rate the operator set for their hosted provider,
    // and `undefined` here lets the LLM layer apply the provider's own default —
    // which is the only place that knows local means zero.
    const options = resolveLlmClientOptions(arm.config);
    const client = createLlmClient(arm.config, {
      ...options,
      prices: arm.prices ?? undefined,
    });

    const runs: CaseResult[][] = [];
    for (let i = 0; i < repeats; i++) {
      process.stdout.write(`  running ${arm.label} (${i + 1}/${repeats})\r`);
      runs.push(await runEval({ client, verifier }));
    }
    scored.push(summariseArm(arm.label, runs));
  }
  process.stdout.write(" ".repeat(60) + "\r");

  console.log(formatArmTable(scored));
  console.log("");

  // As elsewhere: the scores are the output, but a broken dataset means the
  // comparison proved nothing about any of them.
  const broken = scored.reduce((total, arm) => total + arm.counts["broken-case"], 0);
  process.exitCode = broken > 0 ? 1 : 0;
} finally {
  await verifier.close();
}
