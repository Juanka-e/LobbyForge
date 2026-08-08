CREATE TABLE "user_identity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(64) NOT NULL,
	"provider_subject" varchar(255) NOT NULL,
	"provider_email" varchar(254),
	"email_verified" boolean DEFAULT false NOT NULL,
	"claims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identity_links_provider_subject_unique" UNIQUE("provider","provider_subject"),
	CONSTRAINT "user_identity_links_user_provider_unique" UNIQUE("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "user_identity_links" ADD CONSTRAINT "user_identity_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_identity_links_user" ON "user_identity_links" USING btree ("user_id");
