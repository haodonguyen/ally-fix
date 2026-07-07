"use client";

import {
  AUTOMATED_SCAN_DISCLAIMER,
  computeAccessibilityScore,
  IMPACT_WEIGHT,
  scoreBand,
  type AuditStatus,
  type Impact,
  type LlmIssueAnalysis,
  type WcagLevel,
} from "@ally-fix/shared";
import { useEffect, useState } from "react";
import { CopyButton } from "./copy-button";
import { IssueAccordion, type RuleGroup } from "./issue-accordion";
import styles from "./report.module.css";

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
const IMPACT_ORDER: Impact[] = ["critical", "serious", "moderate", "minor"];
const IMPACT_CLASS: Record<Impact, string | undefined> = {
  critical: styles.critical,
  serious: styles.serious,
  moderate: styles.moderate,
  minor: styles.minor,
};

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
    <div className={styles.page}>
      <a className={styles.backLink} href="/">
        ← New scan
      </a>

      <header className={styles.header}>
        <h1>Accessibility report</h1>
        <p className={styles.url}>{audit.url}</p>
        <p className={styles.meta}>
          Status: <strong>{audit.status}</strong>
        </p>
      </header>

      {scanning && (
        <p role="status">Scanning… this page updates automatically when the scan finishes.</p>
      )}

      {audit.status === "failed" && (
        <p role="alert" style={{ color: "#b00020" }}>
          The scan failed: {audit.error ?? "unknown error"}
        </p>
      )}

      {audit.status === "completed" && <CompletedReport audit={audit} issues={issues} />}

      <p className={styles.disclaimer}>{AUTOMATED_SCAN_DISCLAIMER}</p>
    </div>
  );
}

function CompletedReport({ audit, issues }: { audit: AuditDto; issues: IssueDto[] }) {
  const score = audit.score ?? computeAccessibilityScore(issues.map((issue) => issue.impact));
  const band = scoreBand(score);
  const counts = countByImpact(issues);
  const ruleGroups = buildRuleGroups(issues);
  const wcagRows = buildWcagRows(issues);

  return (
    <>
      <section aria-labelledby="score-heading">
        <h2 id="score-heading">Score</h2>
        <div className={styles.scoreRow}>
          <p className={`${styles.scoreValue} ${styles[band.band]}`}>
            <span className="sr-only">
              Accessibility score {score} out of 100, {band.label}
            </span>
            <span aria-hidden="true">{score}</span>
            <small aria-hidden="true">/100</small>
          </p>
          <span className={`${styles.band} ${styles[band.band]}`} aria-hidden="true">
            {band.label}
          </span>
        </div>
        <p>
          Found <strong>{issues.length}</strong> automated{" "}
          {issues.length === 1 ? "issue" : "issues"}.
        </p>
        <ul className={styles.counts}>
          {IMPACT_ORDER.map((impact) => (
            <li key={impact} className={styles.count}>
              <strong>{counts[impact]}</strong>
              <span className={`${styles.badge} ${IMPACT_CLASS[impact]}`}>{impact}</span>
            </li>
          ))}
        </ul>
      </section>

      {wcagRows.length > 0 && (
        <section aria-labelledby="wcag-heading">
          <h2 id="wcag-heading">WCAG breakdown</h2>
          <table className={styles.table}>
            <caption>Issues grouped by WCAG 2.2 success criterion</caption>
            <thead>
              <tr>
                <th scope="col">Criterion</th>
                <th scope="col">Level</th>
                <th scope="col">Issues</th>
              </tr>
            </thead>
            <tbody>
              {wcagRows.map((row) => (
                <tr key={row.key}>
                  <td>{row.criteria}</td>
                  <td>
                    {row.level ? (
                      <span className={`${styles.badge} ${styles.levelBadge}`}>{row.level}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section aria-labelledby="issues-heading">
        <h2 id="issues-heading">Issues ({ruleGroups.length})</h2>
        {ruleGroups.length > 0 ? (
          <IssueAccordion groups={ruleGroups} />
        ) : (
          <p>No automated issues were detected. Manual testing is still recommended.</p>
        )}
      </section>

      <section aria-labelledby="share-heading">
        <h2 id="share-heading">Share</h2>
        <p>Anyone with this link can view the report.</p>
        <ShareReport />
      </section>
    </>
  );
}

function ShareReport() {
  const [url, setUrl] = useState("");
  useEffect(() => setUrl(window.location.href), []);
  if (!url) return null;
  return <CopyButton text={url} label="Copy report link" secondary />;
}

// --- Aggregation helpers -----------------------------------------------------

interface WcagRow {
  key: string;
  criteria: string;
  level: WcagLevel | null;
  count: number;
}

function impactWeight(impact: Impact | null): number {
  return impact ? IMPACT_WEIGHT[impact] : 0;
}

function countByImpact(issues: IssueDto[]): Record<Impact, number> {
  const counts: Record<Impact, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const issue of issues) {
    if (issue.impact) counts[issue.impact]++;
  }
  return counts;
}

/** Collapse issues into one group per axe rule, keeping the worst impact. */
function buildRuleGroups(issues: IssueDto[]): RuleGroup[] {
  const groups = new Map<string, RuleGroup>();
  for (const issue of issues) {
    const existing = groups.get(issue.ruleId);
    if (existing) {
      existing.count++;
      if (issue.selector && !existing.selectors.includes(issue.selector)) {
        existing.selectors.push(issue.selector);
      }
      if (impactWeight(issue.impact) > impactWeight(existing.impact)) {
        existing.impact = issue.impact;
      }
      if (!existing.analysis && issue.llmAnalysis) existing.analysis = issue.llmAnalysis;
    } else {
      groups.set(issue.ruleId, {
        ruleId: issue.ruleId,
        wcagCriteria: issue.wcagCriteria,
        wcagLevel: issue.wcagLevel,
        impact: issue.impact,
        count: 1,
        selectors: issue.selector ? [issue.selector] : [],
        analysis: issue.llmAnalysis,
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) => impactWeight(b.impact) - impactWeight(a.impact) || b.count - a.count,
  );
}

/** Count issues per WCAG success criterion for the breakdown table. */
function buildWcagRows(issues: IssueDto[]): WcagRow[] {
  const rows = new Map<string, WcagRow>();
  for (const issue of issues) {
    const criteria = issue.wcagCriteria ?? "Unmapped";
    const existing = rows.get(criteria);
    if (existing) existing.count++;
    else rows.set(criteria, { key: criteria, criteria, level: issue.wcagLevel, count: 1 });
  }
  return [...rows.values()].sort((a, b) => {
    if (a.criteria === "Unmapped") return 1;
    if (b.criteria === "Unmapped") return -1;
    return a.criteria.localeCompare(b.criteria, undefined, { numeric: true });
  });
}
