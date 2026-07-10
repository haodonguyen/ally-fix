// Seeds one completed audit + issues so the report page renders fully in the
// accessibility CI check. Idempotent (fixed ids + onConflictDoNothing).
import { audits, createDb, issues } from "@ally-fix/db";
import { A11Y_AUDIT_ID } from "./fixture";

const db = createDb(process.env.DATABASE_URL ?? "");

await db
  .insert(audits)
  .values({
    id: A11Y_AUDIT_ID,
    url: "https://example.com",
    status: "completed",
    score: 72,
    completedAt: new Date(),
  })
  .onConflictDoNothing();

await db
  .insert(issues)
  .values([
    {
      id: "00000000-0000-0000-0000-0000000000a2",
      auditId: A11Y_AUDIT_ID,
      ruleId: "image-alt",
      wcagCriteria: "1.1.1",
      wcagLevel: "A",
      impact: "critical",
      htmlSnippet: '<img src="cat.png">',
      selector: "img",
      llmAnalysis: {
        explanation: "Images need alternative text so screen readers can describe them.",
        affectedUsers: ["screen reader users", "users with images disabled"],
        fixCode: '<img src="cat.png" alt="A tabby cat asleep on a keyboard">',
        priority: "high",
      },
      rawAxe: {},
    },
    {
      id: "00000000-0000-0000-0000-0000000000a3",
      auditId: A11Y_AUDIT_ID,
      ruleId: "color-contrast",
      wcagCriteria: "1.4.3",
      wcagLevel: "AA",
      impact: "serious",
      htmlSnippet: "<p>low contrast</p>",
      selector: "p",
      llmAnalysis: null,
      rawAxe: {},
    },
  ])
  .onConflictDoNothing();

console.log(`Seeded accessibility fixture audit ${A11Y_AUDIT_ID}`);
process.exit(0);
