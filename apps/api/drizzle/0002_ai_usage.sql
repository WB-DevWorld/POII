CREATE TABLE "ai_preview" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_actor_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"source_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"start_char" integer NOT NULL,
	"end_char" integer NOT NULL,
	"record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt_sha256" text NOT NULL,
	"prompt_chars" integer NOT NULL,
	"input_tokens_estimate" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"estimated_cost_micro_usd" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	CONSTRAINT "ai_preview_provider_check" CHECK ("ai_preview"."provider" IN ('anthropic', 'openai'))
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"month" text NOT NULL,
	"preview_id" uuid NOT NULL,
	"prompt_sha256" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"outcome" text,
	"reserved_micro_usd" bigint NOT NULL,
	"actual_micro_usd" bigint,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "ai_usage_provider_check" CHECK ("ai_usage"."provider" IN ('anthropic', 'openai')),
	CONSTRAINT "ai_usage_state_check" CHECK ("ai_usage"."state" IN ('reserved', 'settled'))
);
--> statement-breakpoint
ALTER TABLE "ai_preview" ADD CONSTRAINT "ai_preview_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_preview" ADD CONSTRAINT "ai_preview_created_by_actor_id_actor_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_preview" ADD CONSTRAINT "ai_preview_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_preview" ADD CONSTRAINT "ai_preview_revision_id_source_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."source_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_actor_id_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_preview_workspace_idx" ON "ai_preview" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ai_usage_provider_month_idx" ON "ai_usage" USING btree ("provider","month");
