CREATE TYPE "public"."client_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('planned', 'active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."record_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "client_status" DEFAULT 'active' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "clients_name_nonempty" CHECK (length(btrim("clients"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "developer_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"headline" text NOT NULL,
	"summary" text NOT NULL,
	"location" text NOT NULL,
	"years_experience" smallint NOT NULL,
	"hourly_rate" numeric(12, 2),
	"availability" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_areas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferred_project_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded_project_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"portfolio_url" text,
	"github_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "developer_profiles_tenant_unique" UNIQUE("tenant_id"),
	CONSTRAINT "developer_profiles_display_name_nonempty" CHECK (length(btrim("developer_profiles"."display_name")) > 0),
	CONSTRAINT "developer_profiles_years_experience_nonnegative" CHECK ("developer_profiles"."years_experience" >= 0),
	CONSTRAINT "developer_profiles_hourly_rate_valid" CHECK ("developer_profiles"."hourly_rate" BETWEEN 0 AND 9999999999.99),
	CONSTRAINT "developer_profiles_availability_object" CHECK (jsonb_typeof("developer_profiles"."availability") = 'object'),
	CONSTRAINT "developer_profiles_skills_array" CHECK (
  jsonb_typeof("developer_profiles"."skills") = 'array'
  AND NOT jsonb_path_exists("developer_profiles"."skills", '$[*] ? (@.type() != "string")')
),
	CONSTRAINT "developer_profiles_service_areas_array" CHECK (
  jsonb_typeof("developer_profiles"."service_areas") = 'array'
  AND NOT jsonb_path_exists("developer_profiles"."service_areas", '$[*] ? (@.type() != "string")')
),
	CONSTRAINT "developer_profiles_preferred_project_types_array" CHECK (
  jsonb_typeof("developer_profiles"."preferred_project_types") = 'array'
  AND NOT jsonb_path_exists("developer_profiles"."preferred_project_types", '$[*] ? (@.type() != "string")')
),
	CONSTRAINT "developer_profiles_excluded_project_types_array" CHECK (
  jsonb_typeof("developer_profiles"."excluded_project_types") = 'array'
  AND NOT jsonb_path_exists("developer_profiles"."excluded_project_types", '$[*] ? (@.type() != "string")')
)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text NOT NULL,
	"problem_statement" text NOT NULL,
	"outcome" text NOT NULL,
	"status" "project_status" DEFAULT 'planned' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"stack" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repository_url" text,
	"production_url" text,
	"portfolio_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_tenant_slug_unique" UNIQUE("tenant_id","slug"),
	CONSTRAINT "projects_name_nonempty" CHECK (length(btrim("projects"."name")) > 0),
	CONSTRAINT "projects_slug_format" CHECK ("projects"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "projects_stack_array" CHECK (
  jsonb_typeof("projects"."stack") = 'array'
  AND NOT jsonb_path_exists("projects"."stack", '$[*] ? (@.type() != "string")')
),
	CONSTRAINT "projects_dates_ordered" CHECK ("projects"."completed_at" IS NULL OR "projects"."started_at" IS NULL OR "projects"."completed_at" >= "projects"."started_at")
);
--> statement-breakpoint
CREATE TABLE "tenant_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_memberships_tenant_user_unique" UNIQUE("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_name_nonempty" CHECK (length(btrim("tenants"."name")) > 0),
	CONSTRAINT "tenants_slug_format" CHECK ("tenants"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_trimmed" CHECK ("users"."email" = btrim("users"."email") AND length("users"."email") > 0),
	CONSTRAINT "users_display_name_nonempty" CHECK (length(btrim("users"."display_name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_profiles" ADD CONSTRAINT "developer_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_tenant_status_idx" ON "projects" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));