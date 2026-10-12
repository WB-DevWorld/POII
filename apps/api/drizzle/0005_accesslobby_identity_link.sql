-- #17 AccessLobby OIDC (ADR-0011). Expand only: two new POII-owned tables, nothing existing is changed.
-- identity_link maps an AccessLobby identity (issuer, sub, person.id) to the owner's sign-in user and actor;
-- each side can be linked at most once. accesslobby_session remembers which POII sessions came from an
-- AccessLobby sign-in (ID token for id_token_hint, issuer session sid).
CREATE TABLE "identity_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"person_id" text NOT NULL,
	"auth_user_id" text NOT NULL,
	"actor_id" uuid,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sign_in_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "accesslobby_session" (
	"session_id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"sid" text,
	"id_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity_link" ADD CONSTRAINT "identity_link_auth_user_id_auth_user_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_link" ADD CONSTRAINT "identity_link_actor_id_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actor"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accesslobby_session" ADD CONSTRAINT "accesslobby_session_session_id_auth_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_link_issuer_subject_unique" ON "identity_link" USING btree ("issuer","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_link_person_unique" ON "identity_link" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_link_user_unique" ON "identity_link" USING btree ("auth_user_id");--> statement-breakpoint
CREATE INDEX "accesslobby_session_sid_idx" ON "accesslobby_session" USING btree ("issuer","sid");
