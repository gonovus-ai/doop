ALTER TABLE "custom_agents" ADD COLUMN "external" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "custom_agents" ADD COLUMN "avatar" text;
--> statement-breakpoint
ALTER TABLE "custom_agents" ADD COLUMN "agent_key_id" text;
--> statement-breakpoint
ALTER TABLE "custom_agents" ADD COLUMN "webhook_url" text;
--> statement-breakpoint
ALTER TABLE "custom_agents" ADD COLUMN "webhook_secret" text;
--> statement-breakpoint
CREATE INDEX "custom_agents_agent_key_idx" ON "custom_agents" USING btree ("agent_key_id");
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "delivery_status" text;
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "delivered_at" bigint;
