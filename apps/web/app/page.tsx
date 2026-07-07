import { AUTOMATED_SCAN_DISCLAIMER } from "@ally-fix/shared";
import { ScanForm } from "./scan-form";

export default function HomePage() {
  return (
    <main style={{ maxWidth: "42rem", margin: "0 auto", padding: "4rem 1.5rem" }}>
      <h1>AllyFix</h1>
      <p>
        Automated accessibility auditing that tells you <strong>why</strong> each issue matters and{" "}
        <strong>how</strong> to fix it — right in your code. Enter a public URL to scan it for WCAG
        issues.
      </p>
      <ScanForm />
      <p style={{ fontSize: "0.875rem", opacity: 0.7, marginTop: "2rem" }}>
        {AUTOMATED_SCAN_DISCLAIMER}
      </p>
    </main>
  );
}
