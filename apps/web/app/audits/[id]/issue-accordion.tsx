"use client";

import type { Impact, LlmIssueAnalysis, WcagLevel } from "@ally-fix/shared";
import * as Accordion from "@radix-ui/react-accordion";
import { CopyButton } from "./copy-button";
import styles from "./report.module.css";

/** One rule's worth of issues, aggregated for display. */
export interface RuleGroup {
  ruleId: string;
  wcagCriteria: string | null;
  wcagLevel: WcagLevel | null;
  impact: Impact | null;
  count: number;
  selectors: string[];
  analysis: LlmIssueAnalysis | null;
}

const IMPACT_CLASS: Record<Impact, string | undefined> = {
  critical: styles.critical,
  serious: styles.serious,
  moderate: styles.moderate,
  minor: styles.minor,
};

export function IssueAccordion({ groups }: { groups: RuleGroup[] }) {
  return (
    <Accordion.Root type="multiple">
      {groups.map((group) => (
        <Accordion.Item key={group.ruleId} value={group.ruleId} className={styles.accordionItem}>
          <Accordion.Header>
            <Accordion.Trigger className={styles.accordionTrigger}>
              <span className={styles.triggerTitle}>
                <code>{group.ruleId}</code>
              </span>
              {group.impact && (
                <span className={`${styles.badge} ${IMPACT_CLASS[group.impact]}`}>
                  {group.impact}
                </span>
              )}
              {group.wcagCriteria && (
                <span className={`${styles.badge} ${styles.levelBadge}`}>
                  WCAG {group.wcagCriteria}
                  {group.wcagLevel ? ` (${group.wcagLevel})` : ""}
                </span>
              )}
              <span className={styles.occurrences}>
                {group.count} {group.count === 1 ? "occurrence" : "occurrences"}
              </span>
              <Chevron />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content className={styles.accordionContent}>
            {group.analysis ? (
              <AnalysisBody analysis={group.analysis} />
            ) : (
              <p>No AI explanation is available for this issue yet.</p>
            )}
            <SelectorList selectors={group.selectors} />
          </Accordion.Content>
        </Accordion.Item>
      ))}
    </Accordion.Root>
  );
}

function AnalysisBody({ analysis }: { analysis: LlmIssueAnalysis }) {
  return (
    <>
      <p>{analysis.explanation}</p>
      <p>
        <strong>Affected users:</strong> {analysis.affectedUsers.join(", ")}
      </p>
      <div className={styles.fixHeader}>
        <strong>Suggested fix</strong>
        <CopyButton text={analysis.fixCode} label="Copy fix" secondary />
      </div>
      <pre className={styles.codeBlock} tabIndex={0}>
        <code>{analysis.fixCode}</code>
      </pre>
      <p className={styles.reviewNote}>
        This fix is an AI-generated suggestion — review it before applying.
      </p>
    </>
  );
}

function SelectorList({ selectors }: { selectors: string[] }) {
  if (selectors.length === 0) return null;
  return (
    <details>
      <summary>Affected elements ({selectors.length})</summary>
      <ul className={styles.selectorList}>
        {selectors.map((selector, index) => (
          <li key={`${selector}-${index}`}>
            <code>{selector}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Decorative expand/collapse indicator; hidden from assistive tech. */
function Chevron() {
  return (
    <svg
      className={styles.chevron}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
