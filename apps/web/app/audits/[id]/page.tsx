import { AuditReport } from "./audit-report";

/** Report page for a single audit. The client component polls for results. */
export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main style={{ maxWidth: "64rem", margin: "0 auto", padding: "2.5rem 1.5rem" }}>
      <AuditReport auditId={id} />
    </main>
  );
}
