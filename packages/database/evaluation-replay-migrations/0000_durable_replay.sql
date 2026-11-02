CREATE SCHEMA "evaluation_replay";
--> statement-breakpoint
CREATE TABLE "evaluation_replay"."identifiers" (
	"identifier" uuid PRIMARY KEY NOT NULL,
	"invocation_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_replay"."invocations" (
	"invocation_id" uuid PRIMARY KEY NOT NULL,
	"approval_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"approval_digest" text NOT NULL,
	"owner_key_fingerprint" text NOT NULL,
	"fixture_manifest_digest" text NOT NULL,
	"scenario_set_digest" text NOT NULL,
	"scenario_id" text NOT NULL,
	"model" text NOT NULL,
	"compatibility_profile" text NOT NULL,
	"plan_digest" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"pricing_verified_at" timestamp with time zone NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"max_calls" integer NOT NULL,
	"max_input_tokens_per_call" integer NOT NULL,
	"max_output_tokens_per_call" integer NOT NULL,
	"max_total_tokens" integer NOT NULL,
	"max_planned_cost_micro_usd" bigint NOT NULL,
	"status" text DEFAULT 'admitted' NOT NULL,
	"started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"outcome" text,
	"last_turn_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "invocations_approval_id_unique" UNIQUE("approval_id"),
	CONSTRAINT "invocations_execution_id_unique" UNIQUE("execution_id"),
	CONSTRAINT "replay_invocation_owner" UNIQUE("invocation_id","execution_id"),
	CONSTRAINT "replay_invocation_digests" CHECK ("evaluation_replay"."invocations"."approval_digest" ~ '^[a-f0-9]{64}$' AND "evaluation_replay"."invocations"."owner_key_fingerprint" ~ '^[a-f0-9]{64}$' AND "evaluation_replay"."invocations"."fixture_manifest_digest" ~ '^[a-f0-9]{64}$' AND "evaluation_replay"."invocations"."scenario_set_digest" ~ '^[a-f0-9]{64}$' AND "evaluation_replay"."invocations"."plan_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "replay_invocation_model" CHECK ("evaluation_replay"."invocations"."model" = 'gpt-4.1-mini-2025-04-14' AND "evaluation_replay"."invocations"."compatibility_profile" = 'gpt41-mini-text-v1-2026-10-29'),
	CONSTRAINT "replay_invocation_scenario" CHECK ("evaluation_replay"."invocations"."scenario_id" IN ('evidence_retrieval','opportunity_selection','score_interpretation','unavailable_information','tenant_boundary','mutation_refusal')),
	CONSTRAINT "replay_invocation_times" CHECK ("evaluation_replay"."invocations"."expires_at" > "evaluation_replay"."invocations"."issued_at" AND "evaluation_replay"."invocations"."expires_at" <= "evaluation_replay"."invocations"."issued_at" + interval '15 minutes' AND "evaluation_replay"."invocations"."expires_at" <= timestamptz '2027-01-14 00:00:00+00' AND "evaluation_replay"."invocations"."pricing_verified_at" <= "evaluation_replay"."invocations"."issued_at" AND "evaluation_replay"."invocations"."admitted_at" >= "evaluation_replay"."invocations"."issued_at" AND "evaluation_replay"."invocations"."admitted_at" < "evaluation_replay"."invocations"."expires_at" AND ("evaluation_replay"."invocations"."started_at" IS NULL OR ("evaluation_replay"."invocations"."started_at" >= "evaluation_replay"."invocations"."admitted_at" AND "evaluation_replay"."invocations"."started_at" < "evaluation_replay"."invocations"."expires_at")) AND ("evaluation_replay"."invocations"."closed_at" IS NULL OR "evaluation_replay"."invocations"."closed_at" >= "evaluation_replay"."invocations"."admitted_at")),
	CONSTRAINT "replay_invocation_limits" CHECK ("evaluation_replay"."invocations"."max_calls" BETWEEN 1 AND 36 AND "evaluation_replay"."invocations"."max_input_tokens_per_call" BETWEEN 1 AND 1000000 AND "evaluation_replay"."invocations"."max_output_tokens_per_call" BETWEEN 16 AND 512 AND "evaluation_replay"."invocations"."max_total_tokens" BETWEEN 1 AND 4096 AND "evaluation_replay"."invocations"."max_planned_cost_micro_usd" BETWEEN 1 AND 1000000 AND "evaluation_replay"."invocations"."max_calls"::bigint * ("evaluation_replay"."invocations"."max_input_tokens_per_call" + "evaluation_replay"."invocations"."max_output_tokens_per_call") <= "evaluation_replay"."invocations"."max_total_tokens" AND "evaluation_replay"."invocations"."last_turn_number" BETWEEN 0 AND least("evaluation_replay"."invocations"."max_calls", 6)),
	CONSTRAINT "replay_invocation_state" CHECK (("evaluation_replay"."invocations"."status" = 'admitted' AND "evaluation_replay"."invocations"."started_at" IS NULL AND "evaluation_replay"."invocations"."closed_at" IS NULL AND "evaluation_replay"."invocations"."outcome" IS NULL AND "evaluation_replay"."invocations"."last_turn_number" = 0) OR ("evaluation_replay"."invocations"."status" = 'running' AND "evaluation_replay"."invocations"."started_at" IS NOT NULL AND "evaluation_replay"."invocations"."closed_at" IS NULL AND "evaluation_replay"."invocations"."outcome" IS NULL) OR ("evaluation_replay"."invocations"."status" = 'closed' AND "evaluation_replay"."invocations"."closed_at" IS NOT NULL AND "evaluation_replay"."invocations"."outcome" IS NOT NULL AND "evaluation_replay"."invocations"."outcome" IN ('success','failure','unknown')))
);
--> statement-breakpoint
CREATE TABLE "evaluation_replay"."turns" (
	"invocation_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"turn_number" integer NOT NULL,
	"turn_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"transcript_digest" text NOT NULL,
	"tool_digest" text NOT NULL,
	"runner_body_digest" text NOT NULL,
	"digest_version" text NOT NULL,
	"stage" text DEFAULT 'issued' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"claimed_at" timestamp with time zone,
	"prepared_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"permit_id" uuid,
	"reservation_id" uuid,
	"raw_body_digest" text,
	"output_cap" integer,
	CONSTRAINT "turns_invocation_id_turn_number_pk" PRIMARY KEY("invocation_id","turn_number"),
	CONSTRAINT "turns_turn_id_unique" UNIQUE("turn_id"),
	CONSTRAINT "turns_permit_id_unique" UNIQUE("permit_id"),
	CONSTRAINT "turns_reservation_id_unique" UNIQUE("reservation_id"),
	CONSTRAINT "replay_turn_number" CHECK ("evaluation_replay"."turns"."turn_number" BETWEEN 1 AND 6),
	CONSTRAINT "replay_turn_digests" CHECK ("evaluation_replay"."turns"."request_digest" ~ '^[a-f0-9]{64}$' AND "evaluation_replay"."turns"."transcript_digest" ~ '^[a-f0-9]{64}$' AND "evaluation_replay"."turns"."tool_digest" ~ '^[a-f0-9]{64}$' AND "evaluation_replay"."turns"."runner_body_digest" ~ '^[a-f0-9]{64}$' AND "evaluation_replay"."turns"."digest_version" = 'json-stringify-v1'),
	CONSTRAINT "replay_turn_times" CHECK (("evaluation_replay"."turns"."claimed_at" IS NULL OR "evaluation_replay"."turns"."claimed_at" >= "evaluation_replay"."turns"."issued_at") AND ("evaluation_replay"."turns"."prepared_at" IS NULL OR "evaluation_replay"."turns"."prepared_at" >= "evaluation_replay"."turns"."claimed_at") AND ("evaluation_replay"."turns"."consumed_at" IS NULL OR "evaluation_replay"."turns"."consumed_at" >= "evaluation_replay"."turns"."prepared_at") AND ("evaluation_replay"."turns"."retired_at" IS NULL OR "evaluation_replay"."turns"."retired_at" >= "evaluation_replay"."turns"."issued_at")),
	CONSTRAINT "replay_turn_state" CHECK (("evaluation_replay"."turns"."stage" = 'issued' AND "evaluation_replay"."turns"."claimed_at" IS NULL AND "evaluation_replay"."turns"."prepared_at" IS NULL AND "evaluation_replay"."turns"."consumed_at" IS NULL) OR ("evaluation_replay"."turns"."stage" = 'claimed' AND "evaluation_replay"."turns"."claimed_at" IS NOT NULL AND "evaluation_replay"."turns"."prepared_at" IS NULL AND "evaluation_replay"."turns"."consumed_at" IS NULL) OR ("evaluation_replay"."turns"."stage" = 'prepared' AND "evaluation_replay"."turns"."claimed_at" IS NOT NULL AND "evaluation_replay"."turns"."prepared_at" IS NOT NULL AND "evaluation_replay"."turns"."consumed_at" IS NULL) OR ("evaluation_replay"."turns"."stage" = 'consumed' AND "evaluation_replay"."turns"."claimed_at" IS NOT NULL AND "evaluation_replay"."turns"."prepared_at" IS NOT NULL AND "evaluation_replay"."turns"."consumed_at" IS NOT NULL)),
	CONSTRAINT "replay_turn_permit" CHECK (("evaluation_replay"."turns"."stage" IN ('issued','claimed') AND "evaluation_replay"."turns"."permit_id" IS NULL AND "evaluation_replay"."turns"."reservation_id" IS NULL AND "evaluation_replay"."turns"."raw_body_digest" IS NULL AND "evaluation_replay"."turns"."output_cap" IS NULL) OR ("evaluation_replay"."turns"."stage" IN ('prepared','consumed') AND "evaluation_replay"."turns"."permit_id" IS NOT NULL AND "evaluation_replay"."turns"."reservation_id" IS NOT NULL AND "evaluation_replay"."turns"."raw_body_digest" IS NOT NULL AND "evaluation_replay"."turns"."raw_body_digest" ~ '^[a-f0-9]{64}$' AND "evaluation_replay"."turns"."output_cap" IS NOT NULL AND "evaluation_replay"."turns"."output_cap" BETWEEN 16 AND 512))
);
--> statement-breakpoint
ALTER TABLE "evaluation_replay"."identifiers" ADD CONSTRAINT "identifiers_invocation_id_invocations_invocation_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "evaluation_replay"."invocations"("invocation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_replay"."turns" ADD CONSTRAINT "replay_turn_owner" FOREIGN KEY ("invocation_id","execution_id") REFERENCES "evaluation_replay"."invocations"("invocation_id","execution_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Invoker guards supplement row CHECKs; no privileged SECURITY DEFINER path.
CREATE FUNCTION evaluation_replay.guard_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE p evaluation_replay.invocations%ROWTYPE;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Replay records are permanent';
  END IF;
  IF TG_TABLE_NAME = 'identifiers' THEN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Immutable replay identifier';
    END IF;
    SELECT * INTO STRICT p FROM evaluation_replay.invocations WHERE invocation_id=NEW.invocation_id FOR UPDATE;
    IF NEW.identifier <> p.invocation_id AND NEW.identifier <> p.approval_id THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Replay identifier binding';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'invocations' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'admitted' OR NEW.last_turn_number <> 0 THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Replay initial state';
      END IF;
    ELSE
      IF OLD.status='closed' OR
        (to_jsonb(NEW) - ARRAY['status','started_at','closed_at','outcome','last_turn_number']) IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['status','started_at','closed_at','outcome','last_turn_number']) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Immutable replay binding';
      END IF;
      IF NEW.status='closed' AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at AND
        NEW.last_turn_number=OLD.last_turn_number THEN
        RETURN NEW;
      END IF;
      IF NOT (
        (OLD.status='admitted' AND NEW.status='running' AND NEW.last_turn_number=0) OR
        (OLD.status='running' AND NEW.status='running' AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at
          AND NEW.last_turn_number=OLD.last_turn_number+1)
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Replay invocation transition';
      END IF;
      IF NEW.last_turn_number > 1 AND EXISTS (
        SELECT FROM evaluation_replay.turns WHERE invocation_id=NEW.invocation_id
          AND turn_number=NEW.last_turn_number-1 AND retired_at IS NULL
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Previous replay turn is active';
      END IF;
    END IF;
    p := NEW;
  ELSE
    SELECT * INTO STRICT p FROM evaluation_replay.invocations WHERE invocation_id=NEW.invocation_id FOR UPDATE;
    IF p.execution_id <> NEW.execution_id OR p.status <> 'running' OR p.last_turn_number <> NEW.turn_number THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Replay turn ownership';
    END IF;
    IF TG_OP='INSERT' THEN
      IF NEW.stage <> 'issued' OR NEW.retired_at IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Replay initial turn';
      END IF;
    ELSE
      IF OLD.retired_at IS NOT NULL OR
        (to_jsonb(NEW) - ARRAY['stage','claimed_at','prepared_at','consumed_at','retired_at','permit_id','reservation_id','raw_body_digest','output_cap']) IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['stage','claimed_at','prepared_at','consumed_at','retired_at','permit_id','reservation_id','raw_body_digest','output_cap']) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Immutable replay turn';
      END IF;
      IF NEW.retired_at IS NOT NULL AND
        (to_jsonb(NEW) - 'retired_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'retired_at') THEN
        RETURN NEW;
      END IF;
      IF NEW.retired_at IS NOT NULL OR NOT (
        (OLD.stage='issued' AND NEW.stage='claimed' AND NEW.prepared_at IS NULL AND NEW.consumed_at IS NULL) OR
        (OLD.stage='claimed' AND NEW.stage='prepared' AND NEW.claimed_at IS NOT DISTINCT FROM OLD.claimed_at AND NEW.consumed_at IS NULL) OR
        (OLD.stage='prepared' AND NEW.stage='consumed' AND
          (to_jsonb(NEW) - ARRAY['stage','consumed_at']) IS NOT DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['stage','consumed_at']))
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Replay turn transition';
      END IF;
    END IF;
    IF NEW.output_cap IS NOT NULL AND NEW.output_cap > p.max_output_tokens_per_call THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Replay output cap';
    END IF;
  END IF;
  IF clock_timestamp() < p.issued_at OR clock_timestamp() >= p.expires_at OR
    p.pricing_verified_at > clock_timestamp() OR p.pricing_verified_at < clock_timestamp() - interval '24 hours' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Replay lifetime';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION evaluation_replay.check_coverage() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE p evaluation_replay.invocations%ROWTYPE;
BEGIN
  SELECT * INTO STRICT p FROM evaluation_replay.invocations WHERE invocation_id=NEW.invocation_id;
  IF NOT EXISTS (SELECT FROM evaluation_replay.identifiers WHERE identifier=p.invocation_id AND invocation_id=p.invocation_id)
    OR NOT EXISTS (SELECT FROM evaluation_replay.identifiers WHERE identifier=p.approval_id AND invocation_id=p.invocation_id)
    OR (SELECT count(*) FROM evaluation_replay.turns WHERE invocation_id=p.invocation_id) <> p.last_turn_number THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Incomplete replay claim';
  END IF;
  IF p.status='closed' AND EXISTS (SELECT FROM evaluation_replay.turns WHERE invocation_id=p.invocation_id AND retired_at IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Active replay turn at closure';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER replay_invocation_guard BEFORE INSERT OR UPDATE OR DELETE ON evaluation_replay.invocations FOR EACH ROW EXECUTE FUNCTION evaluation_replay.guard_write();
--> statement-breakpoint
CREATE TRIGGER replay_identifier_guard BEFORE INSERT OR UPDATE OR DELETE ON evaluation_replay.identifiers FOR EACH ROW EXECUTE FUNCTION evaluation_replay.guard_write();
--> statement-breakpoint
CREATE TRIGGER replay_turn_guard BEFORE INSERT OR UPDATE OR DELETE ON evaluation_replay.turns FOR EACH ROW EXECUTE FUNCTION evaluation_replay.guard_write();
--> statement-breakpoint
CREATE TRIGGER replay_invocation_no_truncate BEFORE TRUNCATE ON evaluation_replay.invocations FOR EACH STATEMENT EXECUTE FUNCTION evaluation_replay.guard_write();
--> statement-breakpoint
CREATE TRIGGER replay_identifier_no_truncate BEFORE TRUNCATE ON evaluation_replay.identifiers FOR EACH STATEMENT EXECUTE FUNCTION evaluation_replay.guard_write();
--> statement-breakpoint
CREATE TRIGGER replay_turn_no_truncate BEFORE TRUNCATE ON evaluation_replay.turns FOR EACH STATEMENT EXECUTE FUNCTION evaluation_replay.guard_write();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER replay_coverage AFTER INSERT OR UPDATE ON evaluation_replay.invocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION evaluation_replay.check_coverage();
--> statement-breakpoint
REVOKE ALL ON SCHEMA evaluation_replay FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA evaluation_replay FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA evaluation_replay FROM PUBLIC;
