CREATE TYPE "public"."actor_kind" AS ENUM('person', 'ai_assistant', 'agent_token', 'system');--> statement-breakpoint
CREATE TYPE "public"."anchor_result" AS ENUM('exact', 'moved', 'lost');--> statement-breakpoint
CREATE TYPE "public"."authority" AS ENUM('owner', 'delegated');--> statement-breakpoint
CREATE TYPE "public"."change_kind" AS ENUM('create', 'edit', 'confirm', 'reject', 'supersede', 'status', 'evidence');--> statement-breakpoint
CREATE TYPE "public"."evidence_role" AS ENUM('primary', 'supporting');--> statement-breakpoint
CREATE TYPE "public"."export_kind" AS ENUM('context_pack', 'backup');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_status" AS ENUM('proposed', 'decided', 'implemented', 'observed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."record_kind" AS ENUM('fact', 'requirement', 'decision', 'question');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('candidate', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('paste', 'upload', 'import');--> statement-breakpoint
CREATE TYPE "public"."stated_role" AS ENUM('owner', 'assistant', 'third_party', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."statement_mode" AS ENUM('quoted', 'pasted', 'paraphrased', 'ai_extracted');--> statement-breakpoint
CREATE TYPE "public"."time_status" AS ENUM('known', 'unknown', 'not_applicable', 'conflicting');--> statement-breakpoint
CREATE TABLE "actor" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "actor_kind" NOT NULL,
	"display_name" text NOT NULL,
	"authority" "authority",
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "actor_authority_persons_only" CHECK ("actor"."kind" = 'person' OR "actor"."authority" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "approval" (
	"id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"approved_by_actor_id" uuid NOT NULL,
	"authority" "authority" NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"antecedent_record_id" uuid,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"request_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "export_kind" NOT NULL,
	"format_version" integer NOT NULL,
	"selection" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"manifest" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_actor_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"key" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"request_sha256" text NOT NULL,
	"status" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "record_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"review_state" "review_state" DEFAULT 'candidate' NOT NULL,
	"lifecycle_status" "lifecycle_status" DEFAULT 'unknown' NOT NULL,
	"stated_by_actor_id" uuid,
	"stated_role" "stated_role" DEFAULT 'unknown' NOT NULL,
	"statement_mode" "statement_mode" NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_at" timestamp with time zone,
	"effective_at_status" time_status DEFAULT 'unknown' NOT NULL,
	"observed_at" timestamp with time zone,
	"observed_at_status" time_status DEFAULT 'not_applicable' NOT NULL,
	"time_conflicts" jsonb,
	"supersedes_record_id" uuid,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"ai_allowed" boolean DEFAULT true NOT NULL,
	"origin" jsonb,
	"version_no" integer DEFAULT 1 NOT NULL,
	"created_by_actor_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED
);
--> statement-breakpoint
CREATE TABLE "record_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"source_id" uuid,
	"original_source_id" uuid NOT NULL,
	"revision_id" uuid,
	"locator" jsonb NOT NULL,
	"role" "evidence_role" DEFAULT 'primary' NOT NULL,
	"anchor_result" "anchor_result" DEFAULT 'exact' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"change_kind" "change_kind" NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changed_by_actor_id" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"media_type" text DEFAULT 'text/plain' NOT NULL,
	"origin" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin_key" text,
	"ai_allowed" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_actor_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"content_text" text NOT NULL,
	"content_sha256" text NOT NULL,
	"byte_length" integer NOT NULL,
	"line_count" integer NOT NULL,
	"storage_key" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_actor_id" uuid NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', content_text)) STORED
);
--> statement-breakpoint
CREATE TABLE "source_tombstone" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"origin_key" text,
	"last_content_sha256" text,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_by_actor_id" uuid NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actor" ADD CONSTRAINT "actor_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_record_id_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_approved_by_actor_id_actor_id_fk" FOREIGN KEY ("approved_by_actor_id") REFERENCES "public"."actor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_antecedent_record_id_record_id_fk" FOREIGN KEY ("antecedent_record_id") REFERENCES "public"."record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_run" ADD CONSTRAINT "export_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_run" ADD CONSTRAINT "export_run_created_by_actor_id_actor_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record" ADD CONSTRAINT "record_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record" ADD CONSTRAINT "record_stated_by_actor_id_actor_id_fk" FOREIGN KEY ("stated_by_actor_id") REFERENCES "public"."actor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record" ADD CONSTRAINT "record_supersedes_record_id_record_id_fk" FOREIGN KEY ("supersedes_record_id") REFERENCES "public"."record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record" ADD CONSTRAINT "record_created_by_actor_id_actor_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_evidence" ADD CONSTRAINT "record_evidence_record_id_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_evidence" ADD CONSTRAINT "record_evidence_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_evidence" ADD CONSTRAINT "record_evidence_revision_id_source_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."source_revision"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_version" ADD CONSTRAINT "record_version_record_id_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_version" ADD CONSTRAINT "record_version_changed_by_actor_id_actor_id_fk" FOREIGN KEY ("changed_by_actor_id") REFERENCES "public"."actor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_created_by_actor_id_actor_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revision" ADD CONSTRAINT "source_revision_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revision" ADD CONSTRAINT "source_revision_created_by_actor_id_actor_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_tombstone" ADD CONSTRAINT "source_tombstone_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_tombstone" ADD CONSTRAINT "source_tombstone_deleted_by_actor_id_actor_id_fk" FOREIGN KEY ("deleted_by_actor_id") REFERENCES "public"."actor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actor_workspace_idx" ON "actor" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "approval_record_idx" ON "approval" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "audit_event_target_idx" ON "audit_event" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "record_workspace_idx" ON "record" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "record_kind_state_idx" ON "record" USING btree ("workspace_id","kind","review_state");--> statement-breakpoint
CREATE INDEX "record_supersedes_idx" ON "record" USING btree ("supersedes_record_id");--> statement-breakpoint
CREATE INDEX "record_search_idx" ON "record" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "record_evidence_record_idx" ON "record_evidence" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "record_evidence_source_idx" ON "record_evidence" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "record_version_unique" ON "record_version" USING btree ("record_id","version_no");--> statement-breakpoint
CREATE INDEX "source_workspace_idx" ON "source" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_origin_key_unique" ON "source" USING btree ("workspace_id","origin_key");--> statement-breakpoint
CREATE UNIQUE INDEX "source_revision_no_unique" ON "source_revision" USING btree ("source_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "source_revision_hash_unique" ON "source_revision" USING btree ("source_id","content_sha256");--> statement-breakpoint
CREATE INDEX "source_revision_search_idx" ON "source_revision" USING gin ("search_vector");