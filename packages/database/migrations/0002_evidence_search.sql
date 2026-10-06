ALTER TABLE "project_evidence" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (
        setweight(to_tsvector('english'::regconfig, coalesce("title", '')), 'A') ||
        setweight(to_tsvector('english'::regconfig, coalesce("summary", '')), 'B') ||
        setweight(to_tsvector('english'::regconfig, coalesce("details", '')), 'C') ||
        setweight(to_tsvector('english'::regconfig,
          coalesce("skills"::text, '') || ' ' ||
          coalesce("capabilities"::text, '') || ' ' ||
          coalesce("business_outcomes"::text, '')
        ), 'D')
      ) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "project_evidence_search_vector_idx" ON "project_evidence" USING gin ("search_vector");