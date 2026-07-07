import { AUTOMATED_SCAN_DISCLAIMER } from "@ally-fix/shared";

/**
 * Placeholder landing page. The real URL-input form and audit flow arrive in
 * Phase 1; this stub just proves the app renders and can consume shared code.
 */
export default function HomePage() {
  return (
    <main style={{ maxWidth: "42rem", margin: "0 auto", padding: "4rem 1.5rem" }}>
      <h1>AllyFix</h1>
      <p>
        Automated accessibility auditing that tells you <strong>why</strong> each issue matters and{" "}
        <strong>how</strong> to fix it — right in your code.
      </p>
      <p style={{ fontSize: "0.875rem", opacity: 0.7 }}>{AUTOMATED_SCAN_DISCLAIMER}</p>
    </main>
  );
}
