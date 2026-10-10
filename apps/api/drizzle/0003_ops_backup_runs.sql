CREATE TABLE "ops_backup_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"target" text NOT NULL,
	"object_key" text,
	"byte_length" bigint,
	"sha256" text,
	"status" text NOT NULL,
	"error" text,
	"workspace_id" uuid,
	"export_run_id" uuid,
	CONSTRAINT "ops_backup_run_status" CHECK ("ops_backup_run"."status" IN ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "ops_backup_run_started_idx" ON "ops_backup_run" USING btree ("started_at");
