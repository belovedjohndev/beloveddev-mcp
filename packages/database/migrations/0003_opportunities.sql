CREATE TYPE "public"."opportunity_budget_type" AS ENUM('fixed', 'hourly');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('new', 'reviewing', 'shortlisted', 'applied', 'rejected', 'won', 'lost', 'archived');--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"title" text NOT NULL,
	"client_name" text,
	"description" text NOT NULL,
	"project_type" text,
	"budget_type" "opportunity_budget_type",
	"amount_min" numeric(12, 2),
	"amount_max" numeric(12, 2),
	"currency" text,
	"required_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferred_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "opportunity_status" DEFAULT 'new' NOT NULL,
	"source_url" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunities_source_format" CHECK (length("opportunities"."source") <= 100 AND "opportunities"."source" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "opportunities_external_id_nonblank" CHECK ("opportunities"."external_id" IS NULL OR "opportunities"."external_id" ~ '[^[:space:]]'),
	CONSTRAINT "opportunities_title_nonblank" CHECK ("opportunities"."title" ~ '[^[:space:]]'),
	CONSTRAINT "opportunities_client_name_nonblank" CHECK ("opportunities"."client_name" IS NULL OR "opportunities"."client_name" ~ '[^[:space:]]'),
	CONSTRAINT "opportunities_description_nonblank" CHECK ("opportunities"."description" ~ '[^[:space:]]'),
	CONSTRAINT "opportunities_project_type_nonblank" CHECK ("opportunities"."project_type" IS NULL OR "opportunities"."project_type" ~ '[^[:space:]]'),
	CONSTRAINT "opportunities_amount_min_valid" CHECK ("opportunities"."amount_min" IS NULL OR "opportunities"."amount_min" BETWEEN 0 AND 9999999999.99),
	CONSTRAINT "opportunities_amount_max_valid" CHECK ("opportunities"."amount_max" IS NULL OR "opportunities"."amount_max" BETWEEN 0 AND 9999999999.99),
	CONSTRAINT "opportunities_amounts_ordered" CHECK ("opportunities"."amount_min" IS NULL OR "opportunities"."amount_max" IS NULL OR "opportunities"."amount_max" >= "opportunities"."amount_min"),
	CONSTRAINT "opportunities_budget_consistent" CHECK (("opportunities"."budget_type" IS NOT NULL OR ("opportunities"."amount_min" IS NULL AND "opportunities"."amount_max" IS NULL))
        AND (("opportunities"."amount_min" IS NULL AND "opportunities"."amount_max" IS NULL)
          OR ("opportunities"."budget_type" IS NOT NULL AND "opportunities"."currency" IS NOT NULL))),
	CONSTRAINT "opportunities_currency_format" CHECK ("opportunities"."currency" IS NULL OR "opportunities"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "opportunities_required_skills_array" CHECK (
  CASE WHEN jsonb_typeof("opportunities"."required_skills") = 'array'
    THEN NOT jsonb_path_exists("opportunities"."required_skills", 'strict $[*] ? (@.type() != "string")')
    ELSE false
  END
),
	CONSTRAINT "opportunities_preferred_skills_array" CHECK (
  CASE WHEN jsonb_typeof("opportunities"."preferred_skills") = 'array'
    THEN NOT jsonb_path_exists("opportunities"."preferred_skills", 'strict $[*] ? (@.type() != "string")')
    ELSE false
  END
)
);
--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_tenant_source_external_unique" ON "opportunities" USING btree ("tenant_id","source","external_id") WHERE "opportunities"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "opportunities_tenant_order_idx" ON "opportunities" USING btree ("tenant_id",coalesce("published_at", "created_at") DESC,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "opportunities_tenant_status_idx" ON "opportunities" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "opportunities_tenant_source_idx" ON "opportunities" USING btree ("tenant_id","source");