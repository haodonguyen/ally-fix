import { AuditReport } from "./audit-report";

/** Report page for a single audit. The client component polls for results. */
export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main style={{ maxWidth: "56rem", margin: "0 auto", padding: "3rem 1.5rem" }}>
      <p>
        <a href="/">← New scan</a>
      </p>
      <AuditReport auditId={id} />
    </main>
  );
}
