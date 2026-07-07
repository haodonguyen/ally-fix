CREATE TABLE "audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"score" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"wcag_criteria" text,
	"wcag_level" text,
	"impact" text,
	"html_snippet" text,
	"selector" text,
	"llm_analysis" jsonb,
	"raw_axe" jsonb
);
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_audit_id_idx" ON "issues" USING btree ("audit_id");