"use client";

import {
  AUTOMATED_SCAN_DISCLAIMER,
  type AuditStatus,
  type Impact,
  type LlmIssueAnalysis,
  type WcagLevel,
} from "@ally-fix/shared";
import { useEffect, useState } from "react";

interface AuditDto {
  id: string;
  url: string;
  status: AuditStatus;
  score: number | null;
  error: string | null;
}

interface IssueDto {
  id: string;
  ruleId: string;
  wcagCriteria: string | null;
  wcagLevel: WcagLevel | null;
  impact: Impact | null;
  htmlSnippet: string | null;
  selector: string | null;
  llmAnalysis: LlmIssueAnalysis | null;
}

interface AuditResponse {
  audit: AuditDto;
  issues: IssueDto[];
}

const TERMINAL: AuditStatus[] = ["completed", "failed"];

export function AuditReport({ auditId }: { auditId: string }) {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const response = await fetch(`/api/audits/${auditId}`);
        if (!response.ok) {
          if (active) setLoadError("Could not load this audit.");
          return true; // stop polling
        }
        const json: AuditResponse = await response.json();
        if (!active) return true;
        setData(json);
        return TERMINAL.includes(json.audit.status);
      } catch {
        if (active) setLoadError("Could not reach the server.");
        return true;
      }
    }

    // Poll immediately, then every 2s until the audit reaches a terminal state.
    let timer: ReturnType<typeof setInterval> | undefined;
    void poll().then((done) => {
      if (done || !active) return;
      timer = setInterval(async () => {
        const finished = await poll();
        if (finished && timer) clearInterval(timer);
      }, 2000);
    });

    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [auditId]);

  if (loadError) {
    return (
      <p role="alert" style={{ color: "#b00020" }}>
        {loadError}
      </p>
    );
  }

  if (!data) {
    return <p role="status">Loading…</p>;
  }

  const { audit, issues } = data;
  const scanning = audit.status === "queued" || audit.status === "running";

  return (
    <>
      <h1 style={{ overflowWrap: "anywhere" }}>Report for {audit.url}</h1>
      <p>
        Status: <strong>{audit.status}</strong>
      </p>

      {scanning && (
        <p role="status">Scanning… this page updates automatically when the scan finishes.</p>
      )}

      {audit.status === "failed" && (
        <p role="alert" style={{ color: "#b00020" }}>
          The scan failed: {audit.error ?? "unknown error"}
        </p>
      )}

      {audit.status === "completed" && (
        <>
          <p>
            Found <strong>{issues.length}</strong> automated accessibility{" "}
            {issues.length === 1 ? "issue" : "issues"}.
          </p>
          {issues.length > 0 && <IssueTable issues={issues} />}
        </>
      )}

      <p style={{ fontSize: "0.875rem", opacity: 0.7, marginTop: "2rem" }}>
        {AUTOMATED_SCAN_DISCLAIMER}
      </p>
    </>
  );
}

function IssueTable({ issues }: { issues: IssueDto[] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1rem" }}>
      <caption style={{ textAlign: "left", marginBottom: "0.5rem" }}>
        Raw WCAG issues detected by axe-core
      </caption>
      <thead>
        <tr>
          <Th>Rule</Th>
          <Th>WCAG</Th>
          <Th>Level</Th>
          <Th>Impact</Th>
          <Th>Element</Th>
          <Th>Explanation &amp; fix</Th>
        </tr>
      </thead>
      <tbody>
        {issues.map((issue) => (
          <tr key={issue.id} style={{ borderTop: "1px solid #ccc", verticalAlign: "top" }}>
            <Td>
              <code>{issue.ruleId}</code>
            </Td>
            <Td>{issue.wcagCriteria ?? "—"}</Td>
            <Td>{issue.wcagLevel ?? "—"}</Td>
            <Td>{issue.impact ?? "—"}</Td>
            <Td>
              <code style={{ fontSize: "0.8rem", overflowWrap: "anywhere" }}>
                {issue.selector ?? issue.htmlSnippet ?? "—"}
              </code>
            </Td>
            <Td>{issue.llmAnalysis ? <AnalysisDetails analysis={issue.llmAnalysis} /> : "—"}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Expandable LLM explanation + suggested fix. Uses native <details> for accessibility. */
function AnalysisDetails({ analysis }: { analysis: LlmIssueAnalysis }) {
  return (
    <details>
      <summary>
        View fix <span aria-hidden="true">·</span>{" "}
        <span style={{ fontSize: "0.8rem" }}>priority: {analysis.priority}</span>
      </summary>
      <p>{analysis.explanation}</p>
      <p style={{ fontSize: "0.85rem" }}>
        <strong>Affected users:</strong> {analysis.affectedUsers.join(", ")}
      </p>
      <pre
        style={{
          background: "#f4f4f4",
          padding: "0.75rem",
          overflowX: "auto",
          fontSize: "0.8rem",
        }}
      >
        <code>{analysis.fixCode}</code>
      </pre>
      <p style={{ fontSize: "0.8rem", opacity: 0.7 }}>
        This fix is an AI-generated suggestion — review it before applying.
      </p>
    </details>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      style={{ textAlign: "left", padding: "0.5rem", borderBottom: "2px solid #333" }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "0.5rem" }}>{children}</td>;
}
