import { z } from "zod";

/**
 * Zod schemas are the single source of truth for AllyFix's domain.
 * TypeScript types are inferred from them (see the `z.infer` exports below),
 * so runtime validation and compile-time types can never drift apart.
 */

// --- Enumerations ------------------------------------------------------------

/** Lifecycle of an audit job as it moves through the scan pipeline. */
export const auditStatusSchema = z.enum(["queued", "running", "completed", "failed"]);
export type AuditStatus = z.infer<typeof auditStatusSchema>;

/** axe-core impact levels, ordered from least to most severe. */
export const impactSchema = z.enum(["minor", "moderate", "serious", "critical"]);
export type Impact = z.infer<typeof impactSchema>;

/** WCAG conformance level. AllyFix focuses on A and AA (AAA is rarely required). */
export const wcagLevelSchema = z.enum(["A", "AA", "AAA"]);
export type WcagLevel = z.infer<typeof wcagLevelSchema>;

/** Fix priority the LLM assigns to an issue, driving dashboard ordering. */
export const issuePrioritySchema = z.enum(["low", "medium", "high"]);
export type IssuePriority = z.infer<typeof issuePrioritySchema>;

// --- LLM structured output (Phase 2) ----------------------------------------

/**
 * The exact JSON the LLM layer must return for each grouped issue.
 * Passed to the Vercel AI SDK as a structured-output schema; a parse failure
 * triggers a retry. This is the core value of the product: not just WHAT is
 * broken, but WHY it matters and HOW to fix it.
 */
export const llmIssueAnalysisSchema = z.object({
  /** Plain-language explanation of the problem, for a non-expert developer. */
  explanation: z.string().min(1),
  /** Which groups of users are affected (e.g. "screen reader users", "keyboard-only users"). */
  affectedUsers: z.array(z.string().min(1)).min(1),
  /** Concrete, copy-pasteable code fix. A suggestion to review — not gospel. */
  fixCode: z.string().min(1),
  /** How urgently this should be fixed relative to other issues. */
  priority: issuePrioritySchema,
});
export type LlmIssueAnalysis = z.infer<typeof llmIssueAnalysisSchema>;

// --- API contracts -----------------------------------------------------------

/**
 * Request body for creating a new audit.
 * SSRF validation (blocking localhost / private IPs / cloud metadata) is applied
 * on top of this in Phase 1 — a valid URL here is necessary but not sufficient.
 */
export const createAuditRequestSchema = z.object({
  url: z.string().url(),
});
export type CreateAuditRequest = z.infer<typeof createAuditRequestSchema>;

// --- Queue payloads ----------------------------------------------------------

/** Payload the web app pushes onto the BullMQ queue for the worker to pick up. */
export const auditJobPayloadSchema = z.object({
  auditId: z.string().uuid(),
  url: z.string().url(),
});
export type AuditJobPayload = z.infer<typeof auditJobPayloadSchema>;
