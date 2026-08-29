import { createLlmClient } from "@ally-fix/llm";
import { resolveLlmClientOptions, resolveLlmConfig } from "../src/env";
import { formatReport, runEval, summarise } from "./run";
import { createAxeVerifier } from "./verify";

/**
 * Entry point for the eval. Needs a real provider and a real browser, so it is a
 * manual script rather than a CI job — a red build on a model's off day helps
 * nobody. The harness in `run.ts` is unit-tested; this runs the model.
 *
 *   pnpm --filter @ally-fix/worker eval
 */
const config = resolveLlmConfig();
const client = createLlmClient(config, resolveLlmClientOptions(config));
const verifier = await createAxeVerifier();

console.log(`\nAllyFix LLM eval — ${config.provider} / ${config.model}\n`);
try {
  const results = await runEval({ client, verifier });
  const scoreboard = summarise(results);
  console.log(formatReport(results, scoreboard));
  console.log("");
  // The score is the output, not a gate. A broken *dataset*, though, means the
  // run proved nothing — that is worth a non-zero exit.
  process.exitCode = scoreboard.counts["broken-case"] > 0 ? 1 : 0;
} finally {
  await verifier.close();
}
