CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_tenant_action_resource_unique" UNIQUE("tenant_id","action","resource_id"),
	CONSTRAINT "audit_logs_action_supported" CHECK ("audit_logs"."action" = 'project_note.created'),
	CONSTRAINT "audit_logs_resource_type_supported" CHECK ("audit_logs"."resource_type" = 'project_note'),
	CONSTRAINT "audit_logs_metadata_shape" CHECK ((
        jsonb_typeof("audit_logs"."metadata") = 'object'
        AND "audit_logs"."metadata" ?& ARRAY['projectId', 'category']
        AND ("audit_logs"."metadata" - 'projectId' - 'category') = '{}'::jsonb
        AND jsonb_typeof("audit_logs"."metadata"->'projectId') = 'string'
        AND jsonb_typeof("audit_logs"."metadata"->'category') = 'string'
      ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "project_notes" ADD CONSTRAINT "project_notes_tenant_id_author_unique" UNIQUE("tenant_id","id","author_user_id");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_note_actor_fk" FOREIGN KEY ("tenant_id","resource_id","actor_user_id") REFERENCES "public"."project_notes"("tenant_id","id","author_user_id") ON DELETE restrict ON UPDATE no action;
