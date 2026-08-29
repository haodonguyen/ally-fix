import { EVAL_CASES } from "./cases";
import { createAxeVerifier } from "./verify";

/**
 * Checks the dataset itself: every case must actually violate the rule it claims.
 * A case that doesn't proves nothing, and would quietly inflate or deflate every
 * future score.
 *
 *   pnpm --filter @ally-fix/worker eval:validate
 */
const verifier = await createAxeVerifier();
let broken = 0;
try {
  for (const c of EVAL_CASES) {
    const outcome = await verifier.check(c.html, c.ruleId);
    const ok = outcome === "violates";
    if (!ok) broken++;
    console.log(`  ${ok ? "OK    " : "BROKEN"} ${c.id.padEnd(34)} ${ok ? "" : outcome}`);
  }
} finally {
  await verifier.close();
}
console.log(`\n  ${EVAL_CASES.length - broken}/${EVAL_CASES.length} cases valid\n`);
process.exitCode = broken > 0 ? 1 : 0;
