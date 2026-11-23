CREATE TABLE "specflow_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"target_agent" text DEFAULT 'claude' NOT NULL,
	"signing_secret" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "specflow_webhooks_user_idx" ON "specflow_webhooks" USING btree ("user_id");
