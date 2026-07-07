import type { AuditStatus, Impact, LlmIssueAnalysis, WcagLevel } from "./schemas";

/**
 * Domain entity types shared between the web app, worker, and db layer.
 * These mirror the database tables (see @ally-fix/db) but stay framework-agnostic
 * so any package can pass them around without importing Drizzle.
 */

/** A single accessibility audit of one URL. */
export interface Audit {
  id: string;
  url: string;
  status: AuditStatus;
  /** Overall accessibility score (0–100), computed in Phase 3. Null until completed. */
  score: number | null;
  createdAt: Date;
  completedAt: Date | null;
  /** Human-readable failure reason when status is "failed". */
  error: string | null;
}

/** A single WCAG issue found within an audit. */
export interface Issue {
  id: string;
  auditId: string;
  /** axe-core rule id, e.g. "color-contrast" or "image-alt". */
  ruleId: string;
  /** WCAG success criterion, e.g. "1.4.3". Null when axe does not map one. */
  wcagCriteria: string | null;
  wcagLevel: WcagLevel | null;
  impact: Impact | null;
  /** The offending HTML, used both for display and as LLM input. */
  htmlSnippet: string | null;
  /** CSS selector locating the node in the page. */
  selector: string | null;
  /** LLM-generated explanation + fix (Phase 2). Null until analysed. */
  llmAnalysis: LlmIssueAnalysis | null;
  /** Raw axe-core result node, stored as JSONB for later re-processing. */
  rawAxe: unknown;
}
