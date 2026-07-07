import { relations } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AuditStatus, Impact, LlmIssueAnalysis, WcagLevel } from "@ally-fix/shared";

/**
 * Database schema for AllyFix (Drizzle ORM + PostgreSQL).
 *
 * Two tables:
 *   audits  — one row per scan of a URL.
 *   issues  — one row per WCAG issue found, linked to its audit.
 *
 * Raw axe output and the LLM analysis are stored as JSONB so we keep the full
 * fidelity of the scan without a rigid column for every axe field.
 */

export const audits = pgTable("audits", {
  id: uuid("id").defaultRandom().primaryKey(),
  url: text("url").notNull(),
  // Enum-like columns use text + a TypeScript union via `$type` for safety
  // without a Postgres enum migration every time the set changes.
  status: text("status").$type<AuditStatus>().notNull().default("queued"),
  score: integer("score"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
});

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    auditId: uuid("audit_id")
      .notNull()
      .references(() => audits.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    wcagCriteria: text("wcag_criteria"),
    wcagLevel: text("wcag_level").$type<WcagLevel>(),
    impact: text("impact").$type<Impact>(),
    htmlSnippet: text("html_snippet"),
    selector: text("selector"),
    // LLM explanation + fix (Phase 2). Null until the issue has been analysed.
    llmAnalysis: jsonb("llm_analysis").$type<LlmIssueAnalysis | null>(),
    // Raw axe-core result node, kept verbatim for re-processing.
    rawAxe: jsonb("raw_axe"),
  },
  (table) => [index("issues_audit_id_idx").on(table.auditId)],
);

export const auditsRelations = relations(audits, ({ many }) => ({
  issues: many(issues),
}));

export const issuesRelations = relations(issues, ({ one }) => ({
  audit: one(audits, {
    fields: [issues.auditId],
    references: [audits.id],
  }),
}));

/** Row types inferred directly from the schema, for use across the codebase. */
export type AuditRow = typeof audits.$inferSelect;
export type NewAuditRow = typeof audits.$inferInsert;
export type IssueRow = typeof issues.$inferSelect;
export type NewIssueRow = typeof issues.$inferInsert;
