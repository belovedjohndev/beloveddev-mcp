CREATE TYPE "public"."blocker_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."blocker_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."evidence_type" AS ENUM('feature', 'architecture', 'integration', 'business_outcome', 'performance', 'security', 'reliability', 'automation', 'client_result');--> statement-breakpoint
CREATE TYPE "public"."note_category" AS ENUM('general', 'decision', 'requirement', 'client_feedback', 'technical', 'follow_up', 'research');--> statement-breakpoint
CREATE TABLE "project_blockers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"severity" "blocker_severity" NOT NULL,
	"status" "blocker_status" DEFAULT 'open' NOT NULL,
	"blocked_since" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_blockers_title_nonblank" CHECK ("project_blockers"."title" ~ '[^[:space:]]'),
	CONSTRAINT "project_blockers_description_nonblank" CHECK ("project_blockers"."description" ~ '[^[:space:]]'),
	CONSTRAINT "project_blockers_resolution_consistent" CHECK (
      ("project_blockers"."status" = 'open' AND "project_blockers"."resolved_at" IS NULL)
      OR ("project_blockers"."status" = 'resolved' AND "project_blockers"."resolved_at" IS NOT NULL)
    ),
	CONSTRAINT "project_blockers_dates_ordered" CHECK ("project_blockers"."resolved_at" >= "project_blockers"."blocked_since")
);
--> statement-breakpoint
CREATE TABLE "project_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"type" "evidence_type" NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"details" text NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"business_outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_evidence_title_nonblank" CHECK ("project_evidence"."title" ~ '[^[:space:]]'),
	CONSTRAINT "project_evidence_summary_nonblank" CHECK ("project_evidence"."summary" ~ '[^[:space:]]'),
	CONSTRAINT "project_evidence_details_nonblank" CHECK ("project_evidence"."details" ~ '[^[:space:]]'),
	CONSTRAINT "project_evidence_skills_array" CHECK (
  CASE WHEN jsonb_typeof("project_evidence"."skills") = 'array'
    THEN NOT jsonb_path_exists("project_evidence"."skills", 'strict $[*] ? (@.type() != "string")')
    ELSE false
  END
),
	CONSTRAINT "project_evidence_capabilities_array" CHECK (
  CASE WHEN jsonb_typeof("project_evidence"."capabilities") = 'array'
    THEN NOT jsonb_path_exists("project_evidence"."capabilities", 'strict $[*] ? (@.type() != "string")')
    ELSE false
  END
),
	CONSTRAINT "project_evidence_business_outcomes_array" CHECK (
  CASE WHEN jsonb_typeof("project_evidence"."business_outcomes") = 'array'
    THEN NOT jsonb_path_exists("project_evidence"."business_outcomes", 'strict $[*] ? (@.type() != "string")')
    ELSE false
  END
)
);
--> statement-breakpoint
CREATE TABLE "project_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"category" "note_category" NOT NULL,
	"content" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_notes_tenant_author_idempotency_unique" UNIQUE("tenant_id","author_user_id","idempotency_key"),
	CONSTRAINT "project_notes_content_nonblank" CHECK ("project_notes"."content" ~ '[^[:space:]]'),
	CONSTRAINT "project_notes_idempotency_key_nonblank" CHECK ("project_notes"."idempotency_key" ~ '[^[:space:]]')
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "project_blockers" ADD CONSTRAINT "project_blockers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_blockers" ADD CONSTRAINT "project_blockers_tenant_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_evidence" ADD CONSTRAINT "project_evidence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_evidence" ADD CONSTRAINT "project_evidence_tenant_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_notes" ADD CONSTRAINT "project_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_notes" ADD CONSTRAINT "project_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_notes" ADD CONSTRAINT "project_notes_tenant_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_notes" ADD CONSTRAINT "project_notes_tenant_author_fk" FOREIGN KEY ("tenant_id","author_user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_blockers_tenant_status_blocked_idx" ON "project_blockers" USING btree ("tenant_id","status","blocked_since","id");--> statement-breakpoint
CREATE INDEX "project_blockers_tenant_project_status_blocked_idx" ON "project_blockers" USING btree ("tenant_id","project_id","status","blocked_since","id");--> statement-breakpoint
CREATE INDEX "project_evidence_tenant_project_created_idx" ON "project_evidence" USING btree ("tenant_id","project_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_notes_tenant_project_created_idx" ON "project_notes" USING btree ("tenant_id","project_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
